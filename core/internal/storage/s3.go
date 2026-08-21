package storage

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

type S3Options struct {
	Endpoint       string
	PublicEndpoint string
	Region         string
	Bucket         string
	AccessKey      string
	SecretKey      string
	Prefix         string
	ForcePathStyle bool
}

type S3BlobStore struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
	prefix    string
}

func NewS3BlobStore(ctx context.Context, options S3Options) (*S3BlobStore, error) {
	options.Region = strings.TrimSpace(options.Region)
	options.Bucket = strings.TrimSpace(options.Bucket)
	options.Prefix = strings.Trim(strings.TrimSpace(options.Prefix), "/")
	if options.Region == "" || options.Bucket == "" {
		return nil, fmt.Errorf("S3 region and bucket are required")
	}
	if (options.AccessKey == "") != (options.SecretKey == "") {
		return nil, fmt.Errorf("S3 access key and secret key must be set together")
	}
	if options.Prefix != "" && !validKey(options.Prefix) {
		return nil, fmt.Errorf("S3 prefix: %w", ErrInvalidKey)
	}
	loadOptions := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(options.Region)}
	if options.AccessKey != "" {
		loadOptions = append(loadOptions, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(options.AccessKey, options.SecretKey, "")))
	}
	configuration, err := awsconfig.LoadDefaultConfig(ctx, loadOptions...)
	if err != nil {
		return nil, fmt.Errorf("load S3 configuration: %w", err)
	}
	client := s3.NewFromConfig(configuration, func(clientOptions *s3.Options) {
		clientOptions.UsePathStyle = options.ForcePathStyle
		if endpoint := strings.TrimSpace(options.Endpoint); endpoint != "" {
			clientOptions.BaseEndpoint = aws.String(endpoint)
		}
	})
	publicEndpoint := strings.TrimSpace(options.PublicEndpoint)
	if publicEndpoint == "" {
		publicEndpoint = strings.TrimSpace(options.Endpoint)
	}
	presignClient := client
	if publicEndpoint != strings.TrimSpace(options.Endpoint) {
		presignClient = s3.NewFromConfig(configuration, func(clientOptions *s3.Options) {
			clientOptions.UsePathStyle = options.ForcePathStyle
			if publicEndpoint != "" {
				clientOptions.BaseEndpoint = aws.String(publicEndpoint)
			}
		})
	}
	return &S3BlobStore{client: client, presigner: s3.NewPresignClient(presignClient), bucket: options.Bucket, prefix: options.Prefix}, nil
}

func (s *S3BlobStore) Driver() string { return "s3" }

func (s *S3BlobStore) Capabilities() Capabilities {
	return Capabilities{StreamingUpload: true, PresignedUpload: true, MultipartUpload: true}
}

func (s *S3BlobStore) Put(ctx context.Context, request PutRequest) (Blob, error) {
	key, err := s.objectKey(request.Key)
	if err != nil {
		return Blob{}, err
	}
	if request.Size < 0 || request.Body == nil {
		return Blob{}, ErrSizeMismatch
	}
	input := &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), Body: request.Body, ContentLength: aws.Int64(request.Size), ContentType: aws.String(request.ContentType)}
	if request.ExpectedSHA256 != nil {
		input.ChecksumSHA256 = aws.String(base64.StdEncoding.EncodeToString(request.ExpectedSHA256[:]))
	}
	if _, err := s.client.PutObject(ctx, input); err != nil {
		return Blob{}, fmt.Errorf("put S3 blob: %w", err)
	}
	result := Blob{Key: request.Key, Size: request.Size, ContentType: request.ContentType}
	if request.ExpectedSHA256 != nil {
		result.SHA256 = *request.ExpectedSHA256
	}
	return result, nil
}

func (s *S3BlobStore) Open(ctx context.Context, key string) (io.ReadCloser, Blob, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return nil, Blob{}, err
	}
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey)})
	if isS3NotFound(err) {
		return nil, Blob{}, ErrNotFound
	}
	if err != nil {
		return nil, Blob{}, fmt.Errorf("open S3 blob: %w", err)
	}
	return result.Body, Blob{Key: key, Size: aws.ToInt64(result.ContentLength), ContentType: aws.ToString(result.ContentType), ModifiedAt: aws.ToTime(result.LastModified)}, nil
}

func (s *S3BlobStore) Stat(ctx context.Context, key string) (Blob, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return Blob{}, err
	}
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey)})
	if isS3NotFound(err) {
		return Blob{}, ErrNotFound
	}
	if err != nil {
		return Blob{}, fmt.Errorf("stat S3 blob: %w", err)
	}
	return Blob{Key: key, Size: aws.ToInt64(result.ContentLength), ContentType: aws.ToString(result.ContentType), ModifiedAt: aws.ToTime(result.LastModified)}, nil
}

func (s *S3BlobStore) List(ctx context.Context) ([]Blob, error) {
	prefix := s.prefix
	if prefix != "" {
		prefix += "/"
	}
	paginator := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: aws.String(s.bucket), Prefix: aws.String(prefix)})
	result := make([]Blob, 0)
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list S3 blobs: %w", err)
		}
		for _, object := range page.Contents {
			key := strings.TrimPrefix(aws.ToString(object.Key), prefix)
			if key == "" || !validKey(key) {
				continue
			}
			result = append(result, Blob{Key: key, Size: aws.ToInt64(object.Size), ModifiedAt: aws.ToTime(object.LastModified)})
		}
	}
	return result, nil
}

func (s *S3BlobStore) Delete(ctx context.Context, key string) error {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return err
	}
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey)}); err != nil {
		return fmt.Errorf("delete S3 blob: %w", err)
	}
	return nil
}

func (s *S3BlobStore) PresignUpload(ctx context.Context, key, contentType string, size int64, expiresIn time.Duration) (*url.URL, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return nil, err
	}
	result, err := s.presigner.PresignPutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey), ContentLength: aws.Int64(size), ContentType: aws.String(contentType)}, s3.WithPresignExpires(expiresIn))
	if err != nil {
		return nil, fmt.Errorf("presign S3 upload: %w", err)
	}
	return url.Parse(result.URL)
}

func (s *S3BlobStore) PresignDownload(ctx context.Context, key string, expiresIn time.Duration) (*url.URL, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return nil, err
	}
	result, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey)}, s3.WithPresignExpires(expiresIn))
	if err != nil {
		return nil, fmt.Errorf("presign S3 download: %w", err)
	}
	return url.Parse(result.URL)
}

func (s *S3BlobStore) BeginMultipart(ctx context.Context, key, contentType string) (MultipartUpload, error) {
	objectKey, err := s.objectKey(key)
	if err != nil {
		return MultipartUpload{}, err
	}
	result, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey), ContentType: aws.String(contentType)})
	if err != nil {
		return MultipartUpload{}, fmt.Errorf("begin S3 multipart upload: %w", err)
	}
	return MultipartUpload{UploadID: aws.ToString(result.UploadId), Key: key}, nil
}

func (s *S3BlobStore) PresignPart(ctx context.Context, upload MultipartUpload, partNumber int32, expiresIn time.Duration) (*url.URL, error) {
	if partNumber < 1 || partNumber > 10_000 || upload.UploadID == "" {
		return nil, fmt.Errorf("multipart part is invalid")
	}
	objectKey, err := s.objectKey(upload.Key)
	if err != nil {
		return nil, err
	}
	result, err := s.presigner.PresignUploadPart(ctx, &s3.UploadPartInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey), UploadId: aws.String(upload.UploadID), PartNumber: aws.Int32(partNumber)}, s3.WithPresignExpires(expiresIn))
	if err != nil {
		return nil, fmt.Errorf("presign S3 upload part: %w", err)
	}
	return url.Parse(result.URL)
}

func (s *S3BlobStore) CompleteMultipart(ctx context.Context, upload MultipartUpload, completed []CompletedPart) (Blob, error) {
	if upload.UploadID == "" || len(completed) == 0 {
		return Blob{}, fmt.Errorf("multipart completion is invalid")
	}
	objectKey, err := s.objectKey(upload.Key)
	if err != nil {
		return Blob{}, err
	}
	sort.Slice(completed, func(i, j int) bool { return completed[i].Number < completed[j].Number })
	parts := make([]types.CompletedPart, len(completed))
	for index, part := range completed {
		if part.Number < 1 || part.ETag == "" {
			return Blob{}, fmt.Errorf("multipart completion contains an invalid part")
		}
		parts[index] = types.CompletedPart{PartNumber: aws.Int32(part.Number), ETag: aws.String(part.ETag)}
	}
	if _, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey), UploadId: aws.String(upload.UploadID), MultipartUpload: &types.CompletedMultipartUpload{Parts: parts}}); err != nil {
		return Blob{}, fmt.Errorf("complete S3 multipart upload: %w", err)
	}
	return s.Stat(ctx, upload.Key)
}

func (s *S3BlobStore) AbortMultipart(ctx context.Context, upload MultipartUpload) error {
	objectKey, err := s.objectKey(upload.Key)
	if err != nil {
		return err
	}
	if upload.UploadID == "" {
		return nil
	}
	if _, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey), UploadId: aws.String(upload.UploadID)}); err != nil {
		return fmt.Errorf("abort S3 multipart upload: %w", err)
	}
	return nil
}

func (s *S3BlobStore) objectKey(key string) (string, error) {
	if !validKey(key) {
		return "", ErrInvalidKey
	}
	if s.prefix == "" {
		return key, nil
	}
	return s.prefix + "/" + key, nil
}

func isS3NotFound(err error) bool {
	if err == nil {
		return false
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		return apiError.ErrorCode() == "NoSuchKey" || apiError.ErrorCode() == "NotFound" || apiError.ErrorCode() == "NoSuchUpload"
	}
	return false
}
