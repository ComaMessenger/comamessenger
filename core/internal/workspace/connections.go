package workspace

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/emersion/go-sasl"
	smtp "github.com/emersion/go-smtp"
)

type NetworkConnectionTester struct{}

func (NetworkConnectionTester) TestS3(ctx context.Context, value S3Config) error {
	if value.Bucket == "" || value.Region == "" {
		return fmt.Errorf("S3 bucket and region are not configured")
	}
	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(value.Region)}
	if value.AccessKey != "" {
		options = append(options, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(value.AccessKey, value.SecretKey, "")))
	}
	configuration, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return fmt.Errorf("load S3 configuration: %w", err)
	}
	client := s3.NewFromConfig(configuration, func(options *s3.Options) {
		options.UsePathStyle = value.ForcePathStyle
		if value.Endpoint != "" {
			options.BaseEndpoint = aws.String(value.Endpoint)
		}
	})
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := client.HeadBucket(checkCtx, &s3.HeadBucketInput{Bucket: aws.String(value.Bucket)}); err != nil {
		return fmt.Errorf("S3 bucket check failed: %w", err)
	}
	return nil
}

func (NetworkConnectionTester) TestSMTP(ctx context.Context, value SMTPConfig) error {
	client, err := dialSMTP(ctx, value)
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.Noop(); err != nil {
		return fmt.Errorf("SMTP NOOP failed: %w", err)
	}
	return client.Quit()
}

func dialSMTP(ctx context.Context, value SMTPConfig) (*smtp.Client, error) {
	if value.Host == "" || value.Port == 0 {
		return nil, fmt.Errorf("SMTP host and port are not configured")
	}
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	address := net.JoinHostPort(value.Host, strconv.Itoa(value.Port))
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("SMTP connection failed: %w", err)
	}
	tlsConfig := &tls.Config{ServerName: value.Host, MinVersion: tls.VersionTLS12}
	deadline := time.Now().Add(10 * time.Second)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	_ = connection.SetDeadline(deadline)
	var client *smtp.Client
	if value.Security == "tls" {
		tlsConnection := tls.Client(connection, tlsConfig)
		if err := tlsConnection.HandshakeContext(ctx); err != nil {
			connection.Close()
			return nil, fmt.Errorf("SMTP TLS handshake failed: %w", err)
		}
		client = smtp.NewClient(tlsConnection)
	} else if value.Security == "starttls" {
		client, err = smtp.NewClientStartTLS(connection, tlsConfig)
		if err != nil {
			connection.Close()
			return nil, fmt.Errorf("SMTP STARTTLS failed: %w", err)
		}
	} else {
		client = smtp.NewClient(connection)
	}
	defer client.Close()
	if value.Username != "" {
		if ok, _ := client.Extension("AUTH"); !ok {
			client.Close()
			return nil, fmt.Errorf("SMTP server does not advertise AUTH")
		}
		if err := client.Auth(sasl.NewPlainClient("", value.Username, value.Password)); err != nil {
			client.Close()
			return nil, fmt.Errorf("SMTP authentication failed: %w", err)
		}
	}
	return client, nil
}

func sendSMTP(ctx context.Context, value SMTPConfig, recipient, subject, body string) error {
	client, err := dialSMTP(ctx, value)
	if err != nil {
		return err
	}
	defer client.Close()
	from := (&mail.Address{Name: value.FromName, Address: value.FromAddress}).String()
	message := strings.Join([]string{
		"From: " + from,
		"To: " + recipient,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		body,
	}, "\r\n")
	if err := client.SendMail(value.FromAddress, []string{recipient}, io.NopCloser(strings.NewReader(message))); err != nil {
		return fmt.Errorf("send SMTP message: %w", err)
	}
	return client.Quit()
}
