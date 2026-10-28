import { useEffect, useRef, useState } from 'react';
import { copyText } from './LogView.jsx';

// Outline icons from the Lucide set (ISC licence), drawn the way the chat apps draw them.
const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

const CopyIcon = () => (
  <Icon>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Icon>
);
const CheckIcon = () => (
  <Icon>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);
const SpeakerIcon = () => (
  <Icon>
    <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
    <path d="M16 9a5 5 0 0 1 0 6" />
    <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
  </Icon>
);
const StopIcon = () => (
  <Icon>
    <rect width="14" height="14" x="5" y="5" rx="2" />
  </Icon>
);
const ThumbUpIcon = () => (
  <Icon>
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
  </Icon>
);
const ThumbDownIcon = () => (
  <Icon>
    <path d="M17 14V2" />
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
  </Icon>
);

/**
 * The four small buttons under an answer: copy it, read it aloud, and mark it good or bad.
 * Reading aloud uses the browser's own voice (the button is left out where the browser has none).
 * The thumbs only mark the answer on this page; nothing is sent anywhere.
 * @param {{ text: string }} props the answer as plain text
 */
export default function SummaryActions({ text }) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [vote, setVote] = useState(null); // 'up', 'down' or null
  const timer = useRef(null);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  // Leaving the page (or a new search replacing the answer) stops any reading and clears the timer.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (canSpeak) window.speechSynthesis.cancel();
    },
    [canSpeak],
  );

  async function onCopy() {
    await copyText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2500);
  }

  function onSpeak() {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || 'en-US';
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }

  return (
    <div className="summary-actions" role="group" aria-label="Actions for this answer">
      <button type="button" className="summary-action" onClick={onCopy} aria-label={copied ? 'Copied' : 'Copy'} title={copied ? 'Copied' : 'Copy'}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {canSpeak && (
        <button type="button" className={`summary-action${speaking ? ' on' : ''}`} onClick={onSpeak} aria-label={speaking ? 'Stop reading' : 'Read aloud'} title={speaking ? 'Stop reading' : 'Read aloud'}>
          {speaking ? <StopIcon /> : <SpeakerIcon />}
        </button>
      )}
      <button type="button" className={`summary-action${vote === 'up' ? ' on' : ''}`} aria-pressed={vote === 'up'} onClick={() => setVote(vote === 'up' ? null : 'up')} aria-label="Good answer" title="Good answer">
        <ThumbUpIcon />
      </button>
      <button type="button" className={`summary-action${vote === 'down' ? ' on' : ''}`} aria-pressed={vote === 'down'} onClick={() => setVote(vote === 'down' ? null : 'down')} aria-label="Bad answer" title="Bad answer">
        <ThumbDownIcon />
      </button>
    </div>
  );
}
