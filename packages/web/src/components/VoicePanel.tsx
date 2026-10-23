import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePushToTalk } from "../speech";
import { MicIcon, MuteIcon, RefreshIcon, SendIcon, SpeakerIcon } from "./icons";

export interface ChatMessage {
  role: "user" | "assistant" | "error";
  text: string;
}

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  speaking: boolean;
  muted: boolean;
  /** The browser refused to play Unrush's voice. */
  voiceBlocked?: boolean;
  onReplay?: () => void;
  /** Read a message aloud (a click is the user gesture browsers need before they allow speech). */
  onSpeak?: (text: string) => void;
  onToggleMute: () => void;
  onSend: (text: string) => void;
  onNewSession: () => void;
  /** Replies that move the story on, shown as chips above the composer. */
  suggestions: string[];
  /** Shown before the conversation starts. */
  intro?: string;
}

export function VoicePanel({ messages, busy, speaking, muted, voiceBlocked, onReplay, onSpeak, onToggleMute, onSend, onNewSession, suggestions, intro }: Props) {
  const [text, setText] = useState("");
  const ptt = usePushToTalk((t) => !busy && onSend(t));
  const scroller = useRef<HTMLDivElement>(null);
  const state: OrbState = ptt.listening ? "listening" : busy ? "thinking" : speaking ? "speaking" : "idle";

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, ptt.interim]);

  // Hold Space to talk (when not typing in a field).
  useEffect(() => {
    if (!ptt.supported) return;
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest("input, textarea");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !typing(e) && !busy) {
        e.preventDefault();
        ptt.start();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e)) ptt.stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [ptt, busy]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText("");
  };

  const label =
    state === "listening" ? "Listening…" : state === "thinking" ? "Thinking…" : state === "speaking" ? "Speaking…" : ptt.supported ? "Hold to talk" : "Type below";

  return (
    <section className="panel voice" aria-label="Conversation">
      <div className="voice-top">
        <button
          className={`orb ${state}`}
          disabled={!ptt.supported || busy}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            ptt.start();
          }}
          onPointerUp={() => ptt.stop()}
          onPointerCancel={() => ptt.stop()}
          aria-label="Push to talk (or hold Space)"
          title={ptt.supported ? "Hold to talk, or hold Space" : "Speech recognition isn't supported in this browser. Use the text box."}
        >
          <span className="ring r1" />
          <span className="ring r2" />
          <span className="orb-core">
            <MicIcon width={26} height={26} />
          </span>
        </button>
        <div className="orb-text">
          <div className="orb-label">{label}</div>
          {ptt.supported && state === "idle" && <div className="orb-hint">Press and hold the mic, or hold Space</div>}
          {ptt.error && <div className="mic-error">{ptt.error}</div>}
          {voiceBlocked && !muted && (
            <button className="voice-blocked" onClick={onReplay}>
              🔇 Your browser blocked the voice. Click to hear it.
            </button>
          )}
        </div>
      </div>

      <div className="transcript" ref={scroller}>
        {messages.length === 0 && !ptt.interim && intro && (
          <div className="bubble assistant intro">
            {intro}
            {onSpeak && !muted && <HearIt onClick={() => onSpeak(intro)} />}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
            {m.role === "assistant" && onSpeak && !muted && <HearIt onClick={() => onSpeak(m.text)} />}
          </div>
        ))}
        {ptt.interim && <div className="bubble user interim">{ptt.interim}</div>}
        {busy && (
          <div className="bubble assistant typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      {suggestions.length > 0 && !busy && (
        <div className="quick-replies" aria-label="Suggested replies">
          {suggestions.map((s) => (
            <button key={s} className="quick-reply" onClick={() => onSend(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form className="composer" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={busy ? "Working on it…" : "Or type a request…"}
          aria-label="Message"
        />
        <button type="submit" className="icon-btn primary" disabled={!text.trim() || busy} aria-label="Send">
          <SendIcon />
        </button>
      </form>
      <div className="voice-tools">
        <button className="ghost" onClick={onToggleMute} aria-pressed={muted}>
          {muted ? <MuteIcon width={16} height={16} /> : <SpeakerIcon width={16} height={16} />} {muted ? "Voice off" : "Voice on"}
        </button>
        <button className="ghost" onClick={onNewSession} disabled={busy} title="Start a fresh conversation. Long-term memory stays in the MCP server.">
          <RefreshIcon width={16} height={16} /> New session
        </button>
      </div>
    </section>
  );
}

function HearIt({ onClick }: { onClick: () => void }) {
  return (
    <button className="hear-it" onClick={onClick} aria-label="Hear this message" title="Hear this message">
      <SpeakerIcon width={14} height={14} /> Hear it
    </button>
  );
}
