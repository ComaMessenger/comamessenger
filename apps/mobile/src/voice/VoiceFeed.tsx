import { Component, useEffect, useRef, type ReactNode } from "react";
import type { ClientMessage } from "@comamessenger/core";
import { nextVoiceFile, type VoiceFile } from "./model";
import { currentVoiceKey, stopVoice } from "./player";

type Feed = { current: readonly ClientMessage[] };

/** Feeds on screen (a chat, and a thread opened over it). */
const feeds = new Set<Feed>();

/**
 * The voice message to play after `fileID` ends: the next message of the
 * feed that holds it, if that one is a voice message too.
 */
export function nextVoiceInFeeds(fileID: string): VoiceFile | null {
  for (const feed of feeds) {
    const next = nextVoiceFile(feed.current, fileID);
    if (next) return next;
  }
  return null;
}

/**
 * Registers the messages of a conversation screen, in feed order, for
 * playing voice messages one after another. Closing the screen stops what
 * plays from it, and only that: a thread closing does not stop the chat.
 */
export function useVoiceFeed(messages: readonly ClientMessage[]) {
  const feed = useRef<Feed>({ current: messages });
  feed.current.current = messages;
  useEffect(() => {
    const own = feed.current;
    feeds.add(own);
    return () => {
      feeds.delete(own);
      const key = currentVoiceKey();
      if (
        key &&
        own.current.some((message) =>
          message.files?.some((file) => file.id === key),
        )
      )
        stopVoice(key);
    };
  }, []);
}

/** Shows `fallback` (the plain attachment) if a voice view throws. */
export class VoiceBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
