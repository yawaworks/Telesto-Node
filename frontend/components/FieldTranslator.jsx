"use client";

import { useEffect, useRef, useState } from "react";
import { listTranslationLanguages, translateText } from "../lib/workspaceApi";
import { TranslateIcon, TrashIcon } from "./icons";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

/**
 * Third of the three human-language translation touchpoints (chat,
 * Species Inspector, this) — real-time-ish speech translation for
 * fieldwork interviews (TEK collection, local marine authorities), the
 * "fieldwork & local knowledge acquisition" use case from the plan doc.
 *
 * Pipeline: record -> POST /transcribe (Whisper, app/speech.py) -> POST
 * /translate (app/translate.py) -> optionally read aloud via the
 * browser's built-in speechSynthesis (free, no backend involved).
 * Session-only — nothing here is saved server-side; the running
 * exchange history is just local component state so an interview can
 * scroll back through what's been said, and disappears when this modal
 * closes.
 *
 * Consent note, said out loud in the UI rather than left implicit:
 * transcription and translation are both machine-generated and will
 * make mistakes, especially on accented speech, wind/engine noise, and
 * technical or legal terms — this is not a substitute for a human
 * interpreter anywhere informed consent, legal rights, or anything a
 * participant needs to fully understand is being discussed.
 */
export default function FieldTranslator({ onClose }) {
  const [languages, setLanguages] = useState([{ code: "en", name: "English" }]);
  const [speakerLang, setSpeakerLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("en");

  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false); // transcribing and/or translating
  const [error, setError] = useState(null);
  const [exchanges, setExchanges] = useState([]); // [{ id, transcript, detectedLang, translation, targetLang }]
  const [ttsSupported, setTtsSupported] = useState(false);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  useEffect(() => {
    listTranslationLanguages()
      .then(setLanguages)
      .catch((err) => console.error("Failed to load translation languages:", err));
    setTtsSupported(typeof window !== "undefined" && "speechSynthesis" in window);
  }, []);

  useEffect(() => {
    // Stop any in-progress recording and release the mic if this modal
    // unmounts mid-recording — a background mic left open after closing
    // the tool would be a real problem, not just a UI loose end.
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      window.speechSynthesis?.cancel();
    };
  }, []);

  async function handleToggleRecording() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }

    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
        handleProcessRecording(blob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(
        err.name === "NotAllowedError"
          ? "Microphone permission was denied — allow mic access to record."
          : err.message || "Couldn't access the microphone"
      );
    }
  }

  async function handleProcessRecording(blob) {
    setProcessing(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", blob, "recording.webm");
      if (speakerLang !== "auto") form.append("language", speakerLang);

      const transcribeRes = await fetch(`${API_BASE_URL}/transcribe`, { method: "POST", body: form });
      if (!transcribeRes.ok) {
        const body = await transcribeRes.json().catch(() => ({}));
        throw new Error(body.detail || `Transcription failed (${transcribeRes.status})`);
      }
      const transcribed = await transcribeRes.json();

      if (!transcribed.text) {
        setError("Didn't catch any speech in that recording — try again a bit closer to the mic.");
        setProcessing(false);
        return;
      }

      const translated = await translateText({
        text: transcribed.text,
        targetLang,
        sourceLang: speakerLang !== "auto" ? speakerLang : transcribed.detected_language || "auto",
      });

      setExchanges((prev) => [
        {
          id: `${Date.now()}`,
          transcript: transcribed.text,
          detectedLang: transcribed.detected_language,
          transcribeWarning: transcribed.warning,
          translation: translated.translated_text,
          targetLang,
          translateWarning: translated.warning,
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err.message || "Something went wrong processing that recording");
    } finally {
      setProcessing(false);
    }
  }

  function speak(text, langCode) {
    if (!ttsSupported) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = langCode;
    window.speechSynthesis.speak(utterance);
  }

  function clearHistory() {
    setExchanges([]);
  }

  return (
    <div className="w-full max-w-lg max-h-[85vh] sm:max-h-[75vh] flex flex-col bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#3a444a]">
        <div className="flex items-center gap-2">
          <TranslateIcon className="w-3.5 h-3.5 text-[#8fa3ad]" />
          <span className="text-xs uppercase tracking-widest text-[#8fa3ad]">Field translator</span>
        </div>
        <button onClick={onClose} className="text-[#8fa3ad] hover:text-[#d3dbe0] text-sm">
          ✕
        </button>
      </div>

      <div className="px-4 pt-3 pb-2 border-b border-[#3a444a]">
        <p className="text-[10px] text-[#a48a55] leading-relaxed">
          Machine transcription and translation — both will make mistakes, especially with accents,
          wind/engine noise, and technical terms. Don't rely on this alone for informed consent, legal
          rights, or anything a participant needs to fully understand.
        </p>
      </div>

      <div className="px-4 py-3 border-b border-[#3a444a] grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">
            Speaker's language
          </label>
          <select
            value={speakerLang}
            onChange={(e) => setSpeakerLang(e.target.value)}
            className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-2 py-1.5 text-xs text-[#d3dbe0] outline-none focus:border-[#8fa3ad]"
          >
            <option value="auto" className="bg-[#1c2226]">Auto-detect</option>
            {languages.map((lang) => (
              <option key={lang.code} value={lang.code} className="bg-[#1c2226]">
                {lang.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">Translate to</label>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-2 py-1.5 text-xs text-[#d3dbe0] outline-none focus:border-[#8fa3ad]"
          >
            {languages.map((lang) => (
              <option key={lang.code} value={lang.code} className="bg-[#1c2226]">
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-[#3a444a] flex flex-col items-center gap-2">
        <button
          onClick={handleToggleRecording}
          disabled={processing}
          className={`w-16 h-16 rounded-full border-2 flex items-center justify-center transition disabled:opacity-40 ${
            recording
              ? "bg-[#c47a6e]/20 border-[#c47a6e] animate-pulse"
              : "bg-[#8fa3ad]/10 border-[#8fa3ad]/60 hover:bg-[#8fa3ad]/20"
          }`}
          aria-label={recording ? "Stop recording" : "Start recording"}
        >
          <span className={`w-5 h-5 ${recording ? "bg-[#c47a6e] rounded-sm" : "bg-[#8fa3ad] rounded-full"}`} />
        </button>
        <p className="text-[10px] uppercase tracking-widest text-[#5a6a72]">
          {processing ? "Transcribing & translating…" : recording ? "Recording — tap to stop" : "Tap to record"}
        </p>
        {error && <p className="text-xs text-[#c47a6e] text-center">{error}</p>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {exchanges.length === 0 && !processing && (
          <p className="text-xs text-[#5a6a72] text-center py-6">
            Recorded exchanges will appear here, most recent first.
          </p>
        )}
        {exchanges.map((ex) => (
          <div key={ex.id} className="bg-black/20 border border-[#3a444a] rounded-lg p-3 flex flex-col gap-2">
            <div>
              <p className="text-[9px] uppercase tracking-widest text-[#5a6a72] mb-0.5">
                Heard{ex.detectedLang ? ` (${ex.detectedLang})` : ""}
              </p>
              <p className="text-sm text-[#b7c4cc]">{ex.transcript}</p>
            </div>
            <div className="pl-2 border-l-2 border-[#8fa3ad]/40 flex items-start justify-between gap-2">
              <div>
                <p className="text-[9px] uppercase tracking-widest text-[#5a6a72] mb-0.5">
                  Translated ({ex.targetLang})
                </p>
                <p className="text-sm text-[#d3dbe0]">{ex.translation}</p>
              </div>
              {ttsSupported && (
                <button
                  onClick={() => speak(ex.translation, ex.targetLang)}
                  className="shrink-0 text-[9px] uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0] whitespace-nowrap"
                >
                  ▶ Play
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {exchanges.length > 0 && (
        <div className="px-4 py-2 border-t border-[#3a444a] flex justify-end">
          <button
            onClick={clearHistory}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#c47a6e]"
          >
            <TrashIcon className="w-3 h-3" />
            Clear session history
          </button>
        </div>
      )}
    </div>
  );
}