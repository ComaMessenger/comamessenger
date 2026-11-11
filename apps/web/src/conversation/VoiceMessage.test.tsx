import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FileMetadata,
  MessengerAPI,
  VoiceInfo,
} from "@comamessenger/core";
import { VoiceMessage } from "./VoiceMessage";

const file = {
  id: "00000000-0000-4000-8000-000000000901",
  name: "voice.m4a",
  mime: "audio/mp4",
  size: 10,
  status: "ready",
  processing_status: "skipped",
  created_at: "2026-11-11T00:00:00Z",
  uploader_id: "00000000-0000-4000-8000-000000000001",
  voice: { duration_ms: 14_200, waveform: Array(64).fill(128) },
} as FileMetadata & { voice: VoiceInfo };

class FakeAudio extends EventTarget {
  static created = 0;
  paused = true;
  ended = false;
  currentTime = 0;
  duration = 14.2;
  playbackRate = 1;
  preload = "";
  constructor(public src: string) {
    super();
    FakeAudio.created += 1;
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

describe("VoiceMessage", () => {
  let created: string[];
  let revoked: string[];
  beforeEach(() => {
    created = [];
    revoked = [];
    FakeAudio.created = 0;
    vi.stubGlobal("Audio", FakeAudio);
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:voice-${created.length}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => revoked.push(url));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps nothing when it unmounts while the recording downloads", async () => {
    let resolve!: (blob: Blob) => void;
    const api = {
      downloadFile: vi.fn(() => new Promise<Blob>((done) => (resolve = done))),
    } as unknown as MessengerAPI;
    const view = render(<VoiceMessage api={api} file={file} />);
    fireEvent.click(screen.getByRole("button", { name: /Слушать|Play/ }));
    expect(api.downloadFile).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => resolve(new Blob(["m4a"])));
    expect(created).toEqual([]);
    expect(FakeAudio.created).toBe(0);
  });

  it("releases the blob URL of a loaded recording on unmount", async () => {
    const api = {
      downloadFile: vi.fn(() => Promise.resolve(new Blob(["m4a"]))),
    } as unknown as MessengerAPI;
    const view = render(
      <StrictMode>
        <VoiceMessage api={api} file={file} />
      </StrictMode>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Слушать|Play/ }));
    });
    expect(created).toHaveLength(1);
    expect(FakeAudio.created).toBe(1);
    view.unmount();
    expect(revoked).toEqual(created);
  });
});
