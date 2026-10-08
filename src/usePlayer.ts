import { useCallback, useEffect, useRef, useState } from "react";

export function usePlayer(onError?: (error: unknown) => void) {
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const context = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const gain = useRef<GainNode | null>(null);
  const buffer = useRef<AudioBuffer | null>(null);
  const start = useRef(0);
  const offset = useRef(0);
  const playingRef = useRef(false);
  const loopRef = useRef(false);
  const volumeRef = useRef(0.8);
  const playRequest = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [loop, setLoop] = useState(false);

  const stopNode = useCallback(() => {
    if (source.current) {
      source.current.onended = null;
      try {
        source.current.stop();
      } catch {
        /* already stopped */
      }
      source.current.disconnect();
      source.current = null;
    }
  }, []);
  const now = useCallback(() => {
    const raw =
      playingRef.current && context.current
        ? context.current.currentTime - start.current + offset.current
        : offset.current;
    return buffer.current
      ? loopRef.current
        ? raw % buffer.current.duration
        : Math.min(raw, buffer.current.duration)
      : 0;
  }, []);
  const play = useCallback(
    async (at?: number) => {
      if (!buffer.current) return;
      const request = ++playRequest.current;
      const requestedBuffer = buffer.current;
      context.current ??= new AudioContext();
      const requestedContext = context.current;
      try {
        await requestedContext.resume();
      } catch (error) {
        if (request !== playRequest.current) return;
        throw error;
      }
      // Reset, pause, a newer seek, or loading another work can happen while
      // resume is waiting for an output device. Never start stale audio.
      if (
        request !== playRequest.current ||
        requestedBuffer !== buffer.current ||
        requestedContext !== context.current ||
        requestedContext.state === "closed"
      ) return;
      stopNode();
      gain.current ??= context.current.createGain();
      gain.current.gain.value = volumeRef.current;
      gain.current.disconnect();
      gain.current.connect(context.current.destination);
      const node = context.current.createBufferSource();
      node.buffer = buffer.current;
      node.loop = loopRef.current;
      node.connect(gain.current);
      offset.current = at ?? offset.current;
      if (offset.current >= buffer.current.duration - 0.01) offset.current = 0;
      start.current = context.current.currentTime;
      node.onended = () => {
        if (source.current !== node) return;
        playingRef.current = false;
        setPlaying(false);
        offset.current = 0;
        setPosition(0);
      };
      node.start(0, offset.current);
      source.current = node;
      playingRef.current = true;
      setPlaying(true);
    },
    [stopNode],
  );
  const pause = useCallback(() => {
    playRequest.current++;
    offset.current = now();
    stopNode();
    playingRef.current = false;
    setPlaying(false);
    setPosition(offset.current);
  }, [now, stopNode]);
  const seek = useCallback(
    (time: number) => {
      const value = Math.max(0, Math.min(time, buffer.current?.duration ?? 0));
      if (playingRef.current) void play(value).catch((error) => errorHandler.current?.(error));
      else {
        offset.current = value;
        setPosition(value);
      }
    },
    [play],
  );
  const load = useCallback(
    (next: AudioBuffer, preserve = false) => {
      playRequest.current++;
      const wasPlaying = playingRef.current;
      const pos = preserve ? now() : 0;
      stopNode();
      playingRef.current = false;
      setPlaying(false);
      buffer.current = next;
      offset.current = Math.min(pos, next.duration);
      setPosition(offset.current);
      setDuration(next.duration);
      if (preserve && wasPlaying) void play(offset.current).catch((error) => errorHandler.current?.(error));
    },
    [now, play, stopNode],
  );
  useEffect(() => {
    let frame: number;
    const tick = () => {
      if (playingRef.current) setPosition(now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [now]);
  useEffect(
    () => () => {
      playRequest.current++;
      stopNode();
      void context.current?.close();
    },
    [stopNode],
  );
  return {
    playing,
    position,
    duration,
    volume,
    loop,
    load,
    play,
    pause,
    seek,
    setVolume: (value: number) => {
      volumeRef.current = value;
      setVolume(value);
      if (gain.current)
        gain.current.gain.setTargetAtTime(
          value,
          context.current!.currentTime,
          0.025,
        );
    },
    setLoop: (value: boolean) => {
      // Elapsed time may already span several loop turns. Rebase it to the
      // audible position before changing whether now() uses modulo arithmetic.
      const position = now();
      offset.current = value && buffer.current && position >= buffer.current.duration ? 0 : position;
      if (playingRef.current && context.current)
        start.current = context.current.currentTime;
      loopRef.current = value;
      setLoop(value);
      setPosition(offset.current);
      if (source.current) source.current.loop = value;
    },
  };
}
