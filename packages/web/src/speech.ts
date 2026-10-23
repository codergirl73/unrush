/** Browser speech: push-to-talk recognition (Web Speech API) and spoken replies (speechSynthesis). */
import { useCallback, useEffect, useRef, useState } from "react";

// Minimal typings — SpeechRecognition isn't in lib.dom for all browsers.
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function getRecognitionCtor(): (new () => Recognition) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function usePushToTalk(onFinal: (text: string) => void) {
  const supported = typeof window !== "undefined" && !!getRecognitionCtor();
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const transcript = useRef("");
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor || rec.current) return;
    window.speechSynthesis?.cancel();
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true;
    transcript.current = "";
    setInterim("");
    setError(null);
    r.onresult = (e) => {
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) finalText += res[0].transcript;
        else interimText += res[0].transcript;
      }
      transcript.current = (finalText + " " + interimText).trim();
      setInterim(transcript.current);
    };
    r.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") setError(e.error === "not-allowed" ? "Microphone permission denied" : `Mic error: ${e.error}`);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      const text = transcript.current.trim();
      setInterim("");
      if (text) onFinalRef.current(text);
    };
    rec.current = r;
    r.start();
    setListening(true);
  }, []);

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported, listening, interim, error, start, stop };
}

export function useSpeaker() {
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem("unrush.muted") === "1";
    } catch {
      return false;
    }
  });
  const [speaking, setSpeaking] = useState(false);
  const voice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
      const preferred = [/Samantha/, /Google US English/, /Aria/, /Jenny/, /Natural/, /Karen/, /Daniel/];
      voice.current = preferred.map((re) => voices.find((v) => re.test(v.name))).find(Boolean) ?? voices[0] ?? null;
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  const [blocked, setBlocked] = useState(false);
  const lastText = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const watchdog = useRef<ReturnType<typeof setTimeout>>(undefined);
  const started = useRef(false);

  const speak = useCallback(
    (text: string) => {
      if (muted || !("speechSynthesis" in window)) return;
      const synth = window.speechSynthesis;
      lastText.current = text;
      clearTimeout(timer.current);
      clearTimeout(watchdog.current);
      started.current = false;
      synth.cancel();
      synth.resume(); // Chrome can be left paused or wedged by an earlier utterance
      // Short chunks: Chrome silently stops long utterances (notably the network voices) after ~15 s.
      const chunks: string[] = [];
      for (const sentence of text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]) {
        const last = chunks.length - 1;
        if (last >= 0 && chunks[last]!.length + sentence.length < 140) chunks[last] += sentence;
        else chunks.push(sentence);
      }
      // Chrome drops an utterance started in the same tick as cancel(), so wait a moment.
      const play = (retry: boolean) => {
        chunks.forEach((chunk, i) => {
          const u = new SpeechSynthesisUtterance(chunk.trim());
          if (voice.current && retry) u.voice = voice.current; // the retry uses the browser's default voice
          u.rate = 1.05;
          if (i === 0)
            u.onstart = () => {
              started.current = true;
              clearTimeout(watchdog.current);
              setBlocked(false);
              setSpeaking(true);
            };
          u.onend = () => i === chunks.length - 1 && setSpeaking(false);
          u.onerror = (e) => {
            setSpeaking(false);
            // "canceled"/"interrupted" just mean something newer started; anything else is a real failure.
            if (e.error !== "canceled" && e.error !== "interrupted") setBlocked(true);
          };
          synth.speak(u);
        });
        // The engine sometimes accepts an utterance and never starts it (speaking and pending both stay true).
        // If nothing has started after a moment, reset it and try once more, then tell the user.
        watchdog.current = setTimeout(() => {
          if (started.current) return;
          synth.cancel();
          synth.resume();
          if (retry) setTimeout(() => play(false), 150);
          else setBlocked(true);
        }, 1800);
      };
      timer.current = setTimeout(() => play(true), 80);
    },
    [muted],
  );

  /** Say the last reply again (also the way past a browser that blocks speech before a click). */
  const replay = useCallback(() => {
    setBlocked(false);
    if (lastText.current) speak(lastText.current);
  }, [speak]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      if (next) window.speechSynthesis?.cancel();
      try {
        localStorage.setItem("unrush.muted", next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  return { muted, speaking, speak, toggleMute, blocked, replay };
}
