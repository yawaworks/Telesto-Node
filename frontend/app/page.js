"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { initGamepadNavigation } from "../lib/gamepad-controller";
import { initBathymetryMap } from "../lib/bathymetry-map";
import { loadSpeciesMarkers } from "../lib/species-markers";
import { useFrameDetection } from "../lib/useFrameDetection";
import { useTelemetry } from "../lib/useTelemetry";
import DetectionOverlay from "../components/DetectionOverlay";
import SnapshotAnnotator from "../components/SnapshotAnnotator";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const BLEACHING_ALERT_THRESHOLD = 0.4;
const DEFAULT_SPECIES = "Acropora cervicornis";
const DEFAULT_VIDEO_SRC =
  process.env.NEXT_PUBLIC_DEFAULT_VIDEO_URL ||
  "https://res.cloudinary.com/YOUR_CLOUD_NAME/video/upload/rov-feed.mp4";
const N8N_MISSION_REPORT_WEBHOOK_URL =
  process.env.NEXT_PUBLIC_N8N_MISSION_REPORT_WEBHOOK_URL ||
  "https://yawaworks.app.n8n.cloud/webhook/email-mission-report";

export default function MissionControl() {
  const { data: session, status: sessionStatus } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (sessionStatus === "unauthenticated") {
      router.push("/login");
    }
  }, [sessionStatus, router]);

  // Safety net: normally NextAuth's `pages.newUser` (Google) or the
  // login page's post-signup redirect (credentials) already sends
  // first-time users to /onboarding. This just catches anyone who lands
  // here directly without having finished it.
  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    let cancelled = false;
    fetch("/api/profile")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && !data.onboardingCompleted) {
          router.push("/onboarding");
        }
      })
      .catch((err) => console.error("Onboarding check failed:", err));
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, router]);

  const videoRef = useRef(null);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const fileInputRef = useRef(null);
  const webcamStreamRef = useRef(null);

  const { telemetry } = useTelemetry();
  const telemetryRef = useRef(telemetry);
  useEffect(() => {
    telemetryRef.current = telemetry;
  }, [telemetry]);

  const [speciesQuery, setSpeciesQuery] = useState(DEFAULT_SPECIES);
  const [viewMode, setViewMode] = useState("video");
  // Telemetry and action panels default closed so phones start with an
  // unobstructed feed; sm:flex below forces them open on tablet/desktop
  // regardless of this state.
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);
  const [emailingReport, setEmailingReport] = useState(false);
  const [emailReportMessage, setEmailReportMessage] = useState(null);
  const [snapshotMessage, setSnapshotMessage] = useState(null);
  const handleDiscoverySnapshotRef = useRef(() => {});

  const [videoSourceMode, setVideoSourceMode] = useState("default");
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState(null);
  const [webcamError, setWebcamError] = useState(null);
  const [videoUrlInput, setVideoUrlInput] = useState("");
  const [videoLoadError, setVideoLoadError] = useState(false);

  const [uploadedFile, setUploadedFile] = useState(null);
  const [savingClip, setSavingClip] = useState(false);
  const [shareClip, setShareClip] = useState(false);
  const [clipSaveMessage, setClipSaveMessage] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryScope, setLibraryScope] = useState("mine");
  const [myClips, setMyClips] = useState([]);
  const [sharedClips, setSharedClips] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const [annotatorOpen, setAnnotatorOpen] = useState(false);
  const [annotatorMode, setAnnotatorMode] = useState("new");
  const [annotatorImageSrc, setAnnotatorImageSrc] = useState(null);
  const [annotatorTelemetry, setAnnotatorTelemetry] = useState({});
  const [annotatorSpeciesQuery, setAnnotatorSpeciesQuery] = useState("");
  const [annotatorExistingId, setAnnotatorExistingId] = useState(null);

  const [snapshotLibraryOpen, setSnapshotLibraryOpen] = useState(false);
  const [snapshotLibraryScope, setSnapshotLibraryScope] = useState("mine");
  const [mySnapshots, setMySnapshots] = useState([]);
  const [sharedSnapshots, setSharedSnapshots] = useState([]);
  const [snapshotLibraryLoading, setSnapshotLibraryLoading] = useState(false);

  const { boxes, ghostBoxes, coralBleachingRatio, status } = useFrameDetection(videoRef, {
    enabled: viewMode === "video" && !videoLoadError,
    telemetry,
  });
  const alert =
    coralBleachingRatio !== null && coralBleachingRatio >= BLEACHING_ALERT_THRESHOLD;

  // Mirrors `boxes` into a ref so handleDiscoverySnapshot (and the gamepad
  // A-button path, which calls the same function via a ref) always reads
  // the latest detected species without needing to be redeclared every
  // render or added as a dependency anywhere.
  const boxesRef = useRef(boxes);
  useEffect(() => {
    boxesRef.current = boxes;
  }, [boxes]);

  useEffect(() => {
    const map = initBathymetryMap(mapContainerRef.current);
    mapRef.current = map;
    const cleanupGamepad = initGamepadNavigation({
      videoElement: videoRef.current,
      map,
      onSnapshot: () => handleDiscoverySnapshotRef.current(),
    });

    if (map) {
      map.on("load", () => {
        loadSpeciesMarkers(map, DEFAULT_SPECIES);
      });
    }

    return () => {
      cleanupGamepad?.();
      map?.remove?.();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setVideoLoadError(false);

    if (videoSourceMode === "webcam" && webcamStreamRef.current) {
      video.srcObject = webcamStreamRef.current;
      video.muted = true;
      video.play().catch(() => {});
    } else if (videoSourceMode === "url" && videoUrlInput) {
      video.srcObject = null;
      video.crossOrigin = "anonymous";
      video.src = `${API_BASE_URL}/proxy-video?url=${encodeURIComponent(videoUrlInput)}`;
      video.play().catch(() => {});
    } else {
      video.srcObject = null;
      const nextSrc =
        videoSourceMode === "upload" && uploadedVideoUrl ? uploadedVideoUrl : DEFAULT_VIDEO_SRC;
      if (nextSrc.startsWith("http")) {
        video.crossOrigin = "anonymous";
      } else {
        video.removeAttribute("crossorigin");
      }
      video.src = nextSrc;
      video.play().catch(() => {});
    }
  }, [videoSourceMode, uploadedVideoUrl, videoUrlInput]);

  useEffect(() => {
    return () => {
      webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl);
    webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    webcamStreamRef.current = null;

    const url = URL.createObjectURL(file);
    setUploadedVideoUrl(url);
    setUploadedFile(file);
    setVideoSourceMode("upload");
    setWebcamError(null);
    setClipSaveMessage(null);
  }

  async function handleUseWebcam() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      webcamStreamRef.current = stream;
      setVideoSourceMode("webcam");
      setWebcamError(null);
    } catch (err) {
      console.error("Webcam access denied or unavailable:", err);
      setWebcamError("Camera access denied or unavailable");
    }
  }

  function handleUseDefaultClip() {
    webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    webcamStreamRef.current = null;
    setVideoSourceMode("default");
    setWebcamError(null);
  }

  function handleUseVideoUrl(e) {
    e.preventDefault();
    if (!videoUrlInput.trim()) return;
    webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    webcamStreamRef.current = null;
    setVideoSourceMode("url");
    setWebcamError(null);
  }

  async function handleSaveToLibrary() {
    if (!uploadedFile) return;
    setSavingClip(true);
    setClipSaveMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", uploadedFile);

      const params = new URLSearchParams({
        name: uploadedFile.name || "Untitled clip",
        owner_email: session?.user?.email || "",
        shared: shareClip ? "true" : "false",
      });

      const response = await fetch(`${API_BASE_URL}/clips?${params}`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error(`Save failed: ${response.status}`);

      setClipSaveMessage({ type: "success", text: shareClip ? "Saved to team clips" : "Saved to my clips" });
      setUploadedFile(null);
    } catch (err) {
      console.error("Save to library failed:", err);
      setClipSaveMessage({ type: "error", text: "Couldn't save — check connection and try again" });
    } finally {
      setSavingClip(false);
      setTimeout(() => setClipSaveMessage(null), 4000);
    }
  }

  async function fetchClips(scope) {
    setLibraryLoading(true);
    try {
      const params = new URLSearchParams({ scope });
      if (scope === "mine") params.set("owner_email", session?.user?.email || "");

      const response = await fetch(`${API_BASE_URL}/clips?${params}`);
      if (!response.ok) throw new Error(`Failed to load clips: ${response.status}`);
      const data = await response.json();

      if (scope === "shared") setSharedClips(data);
      else setMyClips(data);
    } catch (err) {
      console.error("Failed to load clip library:", err);
    } finally {
      setLibraryLoading(false);
    }
  }

  function handleOpenLibrary() {
    setLibraryOpen(true);
    fetchClips(libraryScope);
  }

  async function fetchSnapshots(scope) {
    setSnapshotLibraryLoading(true);
    try {
      const params = new URLSearchParams({ scope });
      if (scope === "mine") params.set("owner_email", session?.user?.email || "");

      const response = await fetch(`${API_BASE_URL}/snapshots?${params}`);
      if (!response.ok) throw new Error(`Failed to load snapshots: ${response.status}`);
      const data = await response.json();

      if (scope === "shared") setSharedSnapshots(data);
      else setMySnapshots(data);
    } catch (err) {
      console.error("Failed to load snapshot library:", err);
    } finally {
      setSnapshotLibraryLoading(false);
    }
  }

  function handleOpenSnapshotLibrary() {
    setSnapshotLibraryOpen(true);
    fetchSnapshots(snapshotLibraryScope);
  }

  function handleSwitchSnapshotScope(scope) {
    setSnapshotLibraryScope(scope);
    const alreadyLoaded = scope === "mine" ? mySnapshots.length > 0 : sharedSnapshots.length > 0;
    if (!alreadyLoaded) fetchSnapshots(scope);
  }

  function handleViewSnapshot(snapshot) {
    setAnnotatorMode("view");
    setAnnotatorImageSrc(snapshot.url);
    setAnnotatorTelemetry(snapshot.telemetry || {});
    setAnnotatorSpeciesQuery(snapshot.species_query || "");
    setAnnotatorExistingId(snapshot.id);
    setAnnotatorOpen(true);
  }

  function handleSnapshotSaved() {
    // A newly-saved (or re-annotated, or team-shared) snapshot should show
    // up next time the gallery is opened, and nudge the count on the
    // profile page.
    if (snapshotLibraryOpen) fetchSnapshots(snapshotLibraryScope);
  }

  function handleSnapshotDeleted(id) {
    setMySnapshots((prev) => prev.filter((s) => s.id !== id));
    setSharedSnapshots((prev) => prev.filter((s) => s.id !== id));
  }

  function handleSwitchLibraryScope(scope) {
    setLibraryScope(scope);
    const alreadyLoaded = scope === "mine" ? myClips.length > 0 : sharedClips.length > 0;
    if (!alreadyLoaded) fetchClips(scope);
  }

  async function handleDeleteClip(clip, e) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${clip.name}"? This can't be undone.`)) return;

    try {
      const params = new URLSearchParams({ owner_email: session?.user?.email || "" });
      const response = await fetch(`${API_BASE_URL}/clips/${clip.id}?${params}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`Delete failed: ${response.status}`);

      setMyClips((prev) => prev.filter((c) => c.id !== clip.id));
      setSharedClips((prev) => prev.filter((c) => c.id !== clip.id));
    } catch (err) {
      console.error("Delete clip failed:", err);
      alert("Couldn't delete that clip — check your connection and try again.");
    }
  }

  function handleLoadClipFromLibrary(clip) {
    webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    webcamStreamRef.current = null;
    setUploadedFile(null);
    if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl);
    setUploadedVideoUrl(null);
    setVideoUrlInput(clip.url);
    setVideoSourceMode("url");
    setWebcamError(null);
    setLibraryOpen(false);
  }

  async function handleDiscoverySnapshot() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

      const t = telemetryRef.current;
      // Prefer whatever's actually detected on screen right now over the
      // unrelated map search box — falls back to speciesQuery only if
      // nothing is currently in frame. Read via ref so this always sees
      // the latest detection, whether triggered by the on-screen button
      // or the gamepad A-button path.
      const detectedLabel = boxesRef.current?.[0]?.label;

      // Hand off to the annotation editor (screenshot-tool style) rather
      // than uploading immediately — the researcher decides from there
      // whether to annotate, save, download, or share.
      setAnnotatorMode("new");
      setAnnotatorImageSrc(dataUrl);
      setAnnotatorTelemetry({
        depth: t.depth || "",
        coords: t.coords || "",
        temp: t.temp || "",
        salinity: t.salinity || "",
        heading: t.heading || "",
      });
      setAnnotatorSpeciesQuery(detectedLabel || speciesQuery || "");
      setAnnotatorExistingId(null);
      setAnnotatorOpen(true);
    } catch (err) {
      console.error("Discovery Snapshot capture failed:", err);
      setSnapshotMessage({ type: "error", text: "Couldn't capture the frame" });
      setTimeout(() => setSnapshotMessage(null), 3500);
    }
  }

  useEffect(() => {
    handleDiscoverySnapshotRef.current = handleDiscoverySnapshot;
  });

  function handleSpeciesSearch(e) {
    e.preventDefault();
    if (mapRef.current) {
      loadSpeciesMarkers(mapRef.current, speciesQuery);
    }
  }

  async function handleExportReport() {
    setExportingReport(true);
    try {
      const params = new URLSearchParams(telemetry);
      const response = await fetch(`${API_BASE_URL}/export-report?${params}`);
      if (!response.ok) throw new Error(`Export failed: ${response.status}`);

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "telesto-node-mission-report.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Report export failed:", err);
    } finally {
      setExportingReport(false);
    }
  }

  async function handleEmailReport() {
    const recipientEmail = session?.user?.email;
    if (!recipientEmail) return;

    setEmailingReport(true);
    setEmailReportMessage(null);
    try {
      const response = await fetch(N8N_MISSION_REPORT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...telemetry, recipient_email: recipientEmail }),
      });
      if (!response.ok) throw new Error(`Email report failed: ${response.status}`);

      setEmailReportMessage({ type: "success", text: `Report sent to ${recipientEmail}` });
    } catch (err) {
      console.error("Email report failed:", err);
      setEmailReportMessage({ type: "error", text: "Couldn't send report — check connection and try again" });
    } finally {
      setEmailingReport(false);
      setTimeout(() => setEmailReportMessage(null), 4000);
    }
  }

  const isMapMode = viewMode === "map";

  const activeToast = emailReportMessage || snapshotMessage;

  if (sessionStatus === "unauthenticated") {
    return null;
  }

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#171d20] text-[#d3dbe0] font-mono text-sm">
      {sessionStatus === "loading" && (
        <div className="absolute inset-0 z-50 bg-[#171d20] flex items-center justify-center text-sm">
          Checking mission clearance…
        </div>
      )}

      <video
        ref={videoRef}
        id="feed"
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        muted
        loop={videoSourceMode !== "webcam"}
        playsInline
        onError={() => {
          setVideoLoadError(true);
          if (videoSourceMode === "url") {
            setWebcamError(
              "Couldn't load that video — check the URL is a direct video file link and reachable"
            );
          } else if (videoSourceMode === "default") {
            console.error(
              `Default clip failed to load from "${DEFAULT_VIDEO_SRC}". ` +
              `Confirm the file exists at frontend/public/rov-feed.mp4 and was committed to the repo.`
            );
          } else if (videoSourceMode === "upload") {
            console.error("Uploaded video failed to load.");
          }
        }}
        onLoadedData={() => setVideoLoadError(false)}
        style={{ opacity: isMapMode ? 0 : 1 }}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleFileSelected}
      />

      <DetectionOverlay
        videoRef={videoRef}
        boxes={isMapMode ? [] : boxes}
        ghostBoxes={isMapMode ? [] : ghostBoxes}
      />

      <div
        ref={mapContainerRef}
        className="absolute inset-0 w-full h-full"
        style={{
          opacity: isMapMode ? 1 : 0,
          pointerEvents: isMapMode ? "auto" : "none",
        }}
      />

      <div className="absolute top-0 left-0 right-0 h-14 flex items-center justify-between gap-1 px-2 sm:px-4 bg-[#1c2226]/90 border-b border-[#3a444a] pointer-events-auto overflow-x-auto">
        <div className="flex gap-1 sm:gap-2 shrink-0">
          <button
            onClick={() => setViewMode("video")}
            className={`border rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest whitespace-nowrap ${
              !isMapMode
                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
            }`}
          >
            <span className="sm:hidden">Feed</span>
            <span className="hidden sm:inline">ROV feed</span>
          </button>
          <button
            onClick={() => setViewMode("map")}
            className={`border rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest whitespace-nowrap ${
              isMapMode
                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
            }`}
          >
            <span className="sm:hidden">Map</span>
            <span className="hidden sm:inline">Bathymetry map</span>
          </button>
        </div>

        <div className="hidden sm:flex items-center gap-2 shrink-0">
          {!isMapMode ? (
            <>
              <span
                className={`w-2 h-2 rounded-full ${
                  videoLoadError
                    ? "bg-[#c47a6e]"
                    : status === "live"
                    ? "bg-[#8fa3ad] animate-pulse"
                    : status === "error"
                    ? "bg-[#c47a6e]"
                    : "bg-[#a48a55] animate-pulse"
                }`}
              />
              <span className="text-xs uppercase tracking-widest">
                {videoLoadError
                  ? "Feed error"
                  : status === "live"
                  ? "Inference live"
                  : status === "error"
                  ? "Inference error"
                  : "Connecting…"}
              </span>
            </>
          ) : (
            <span className="text-xs uppercase tracking-widest text-[#5a6a72]">Map mode</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          <button
            onClick={() => setTelemetryOpen((v) => !v)}
            className={`sm:hidden border rounded-lg px-2 py-1.5 text-[10px] uppercase tracking-widest whitespace-nowrap ${
              telemetryOpen
                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc]"
            }`}
          >
            Data
          </button>
          <button
            onClick={() => setActionsOpen((v) => !v)}
            className={`sm:hidden border rounded-lg px-2 py-1.5 text-[10px] uppercase tracking-widest whitespace-nowrap ${
              actionsOpen
                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc]"
            }`}
          >
            Actions
          </button>
          <Link
            href="/profile"
            className="border rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest whitespace-nowrap bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
          >
            Profile
          </Link>
        </div>
      </div>

      {isMapMode && (
        <form
          onSubmit={handleSpeciesSearch}
          className="absolute top-[68px] left-1/2 -translate-x-1/2 pointer-events-auto flex gap-2 px-2 w-full max-w-xs sm:w-auto sm:max-w-none justify-center"
        >
          <input
            type="text"
            value={speciesQuery}
            onChange={(e) => setSpeciesQuery(e.target.value)}
            placeholder="Scientific name…"
            className="bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-1 text-xs text-[#d3dbe0] placeholder:text-[#5a6a72] outline-none focus:border-[#8fa3ad] w-full sm:w-64 min-w-0"
          />
          <button
            type="submit"
            className="shrink-0 bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-lg px-3 py-1 text-xs uppercase tracking-widest hover:bg-[#8fa3ad]/20"
          >
            Plot
          </button>
        </form>
      )}

      <div
        className={`absolute top-[60px] sm:top-[70px] left-2 sm:left-4 w-48 sm:w-56 max-h-[calc(100vh-140px)] overflow-y-auto bg-[#1c2226]/95 sm:bg-[#1c2226]/90 border border-[#3a444a] rounded-xl divide-y divide-[#3a444a] pointer-events-auto sm:pointer-events-none z-20 ${
          telemetryOpen ? "block" : "hidden"
        } sm:block`}
      >
        <div className="flex sm:hidden items-center justify-between px-3 py-1.5 border-b border-[#3a444a]">
          <span className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Telemetry</span>
          <button
            onClick={() => setTelemetryOpen(false)}
            className="pointer-events-auto text-[#8fa3ad] hover:text-[#d3dbe0] text-xs px-1"
          >
            ✕
          </button>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Coordinates · measured</p>
          <p className="text-sm">{telemetry.coords}</p>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">
            Temp · {telemetry.tempSource === "live" ? "measured" : "—"}
          </p>
          <p className="text-lg font-bold">{telemetry.temp}</p>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className="text-[10px] uppercase tracking-widest text-[#a48a55]">Depth · simulated</p>
          <p className="text-lg font-bold">{telemetry.depth}</p>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className="text-[10px] uppercase tracking-widest text-[#a48a55]">Salinity · simulated</p>
          <p className="text-sm border-b border-dashed border-[#a48a55] inline-block">{telemetry.salinity}</p>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className="text-[10px] uppercase tracking-widest text-[#a48a55]">Heading · simulated</p>
          <p className="text-sm border-b border-dashed border-[#a48a55] inline-block">{telemetry.heading}</p>
        </div>
        {!isMapMode && coralBleachingRatio !== null && (
          <div className="px-3 sm:px-4 py-2 sm:py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-[#d8b877]">Coral · unvalidated model</p>
            <p className={`text-sm ${alert ? "text-[#d8b877]" : ""}`}>
              {(coralBleachingRatio * 100).toFixed(0)}% bleached
            </p>
          </div>
        )}
      </div>

      {isMapMode && (
        <div className="absolute bottom-4 left-4 flex gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#8fa3ad]" />
            <span className="text-[10px] text-[#b7c4cc]">verified sighting</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#a48a55]" />
            <span className="text-[10px] text-[#d8b877]">unvalidated detection</span>
          </div>
        </div>
      )}

      <div
        className={`absolute top-[60px] sm:top-[70px] right-2 sm:right-4 w-44 sm:w-48 flex-col gap-2 pointer-events-none z-20 ${
          actionsOpen ? "flex" : "hidden"
        } sm:flex`}
      >
        <div className="flex sm:hidden items-center justify-between bg-[#1c2226]/95 border border-[#3a444a] rounded-lg px-3 py-1.5 pointer-events-auto">
          <span className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Actions</span>
          <button
            onClick={() => setActionsOpen(false)}
            className="text-[#8fa3ad] hover:text-[#d3dbe0] text-xs px-1"
          >
            ✕
          </button>
        </div>
        <button
          onClick={handleDiscoverySnapshot}
          className="pointer-events-auto bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left hover:bg-[#8fa3ad]/20"
        >
          Snapshot
        </button>
        <button
          onClick={handleExportReport}
          disabled={exportingReport}
          className="pointer-events-auto bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left hover:bg-[#8fa3ad]/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {exportingReport && <span className="w-1.5 h-1.5 rounded-full bg-[#8fa3ad] animate-pulse" />}
          {exportingReport ? "Generating…" : "Export field report"}
        </button>
        <button
          onClick={handleEmailReport}
          disabled={emailingReport}
          className="pointer-events-auto bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left hover:bg-[#8fa3ad]/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {emailingReport && <span className="w-1.5 h-1.5 rounded-full bg-[#8fa3ad] animate-pulse" />}
          {emailingReport ? "Sending…" : "Email report"}
        </button>
        {!isMapMode && (
          <button
            onClick={handleOpenLibrary}
            className="pointer-events-auto bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left text-[#b7c4cc] hover:bg-white/[0.08]"
          >
            Clip library
          </button>
        )}
        {!isMapMode && (
          <button
            onClick={handleOpenSnapshotLibrary}
            className="pointer-events-auto bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left text-[#b7c4cc] hover:bg-white/[0.08]"
          >
            Snapshots
          </button>
        )}

        {activeToast && (
          <div
            className={`pointer-events-auto rounded-lg px-3 py-2 text-[11px] border ${
              activeToast.type === "success"
                ? "bg-[#8fa3ad]/10 border-[#8fa3ad]/50 text-[#b7c4cc]"
                : activeToast.type === "error"
                ? "bg-[#c47a6e]/10 border-[#c47a6e]/50 text-[#d99a8f]"
                : "bg-white/[0.04] border-[#3a444a] text-[#d3dbe0]"
            }`}
          >
            {activeToast.text}
          </div>
        )}
      </div>

      {/* Mobile-only fallback: shows the toast even when the actions drawer is closed */}
      {activeToast && !actionsOpen && (
        <div className="sm:hidden absolute bottom-16 left-1/2 -translate-x-1/2 pointer-events-auto z-30 max-w-[90vw]">
          <div
            className={`rounded-lg px-3 py-2 text-[11px] border whitespace-nowrap ${
              activeToast.type === "success"
                ? "bg-[#8fa3ad]/10 border-[#8fa3ad]/50 text-[#b7c4cc]"
                : activeToast.type === "error"
                ? "bg-[#c47a6e]/10 border-[#c47a6e]/50 text-[#d99a8f]"
                : "bg-white/[0.04] border-[#3a444a] text-[#d3dbe0]"
            }`}
          >
            {activeToast.text}
          </div>
        </div>
      )}

      {!isMapMode && alert && (
        <div className="absolute bottom-28 sm:bottom-20 left-2 right-2 sm:left-auto sm:right-4 text-center sm:text-left bg-[#a48a55]/10 border border-[#b38d47] text-[#d8b877] rounded-xl px-3 sm:px-4 py-2 text-[11px] sm:text-xs">
          Possible bleaching — unverified
        </div>
      )}

      {!isMapMode && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 sm:w-16 sm:h-16 border border-[#8fa3ad]/60 rounded-full animate-pulse pointer-events-none" />
      )}

      {!isMapMode && (
        <div className="absolute bottom-0 left-0 right-0 bg-[#1c2226]/90 border-t border-[#3a444a] px-2 sm:px-4 py-2 sm:py-3 pointer-events-auto max-h-[45vh] sm:max-h-none overflow-y-auto">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              onClick={handleUseDefaultClip}
              className={`border rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 text-[9px] sm:text-[10px] uppercase tracking-widest whitespace-nowrap ${
                videoSourceMode === "default"
                  ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                  : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
              }`}
            >
              Default clip
            </button>
            <button
              onClick={handleUploadClick}
              className={`border rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 text-[9px] sm:text-[10px] uppercase tracking-widest whitespace-nowrap ${
                videoSourceMode === "upload"
                  ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                  : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
              }`}
            >
              Upload video
            </button>
            <button
              onClick={handleUseWebcam}
              className={`border rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 text-[9px] sm:text-[10px] uppercase tracking-widest whitespace-nowrap ${
                videoSourceMode === "webcam"
                  ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                  : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
              }`}
            >
              Use webcam
            </button>

            <form onSubmit={handleUseVideoUrl} className="flex gap-1.5 sm:gap-2 w-full sm:w-auto sm:ml-1">
              <input
                type="text"
                value={videoUrlInput}
                onChange={(e) => setVideoUrlInput(e.target.value)}
                placeholder="Paste a direct .mp4 video URL…"
                className="bg-white/[0.04] border border-[#3a444a] rounded-lg px-2 py-1 sm:py-1.5 text-[9px] sm:text-[10px] placeholder:text-[#5a6a72] outline-none focus:border-[#8fa3ad] flex-1 min-w-0 sm:flex-none sm:w-56"
              />
              <button
                type="submit"
                className={`shrink-0 border rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 text-[9px] sm:text-[10px] uppercase tracking-widest whitespace-nowrap ${
                  videoSourceMode === "url"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                Load URL
              </button>
            </form>

            {videoSourceMode === "upload" && uploadedFile && (
              <div className="flex items-center gap-2 bg-white/[0.04] border border-[#3a444a] rounded-lg px-2 py-1 sm:py-1.5 sm:ml-1">
                <label className="flex items-center gap-1 text-[9px] sm:text-[10px] text-[#b7c4cc] cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={shareClip}
                    onChange={(e) => setShareClip(e.target.checked)}
                    className="accent-[#8fa3ad]"
                  />
                  Share with team
                </label>
                <button
                  onClick={handleSaveToLibrary}
                  disabled={savingClip}
                  className="text-[9px] sm:text-[10px] uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {savingClip ? "Saving…" : "Save to library"}
                </button>
              </div>
            )}

            {clipSaveMessage && (
              <span
                className={`text-[9px] sm:text-[10px] rounded px-2 py-1 ${
                  clipSaveMessage.type === "success" ? "text-[#8fa3ad]" : "text-[#c47a6e]"
                }`}
              >
                {clipSaveMessage.text}
              </span>
            )}

            {(webcamError || (videoLoadError && videoSourceMode !== "url")) && (
              <span className="text-[9px] sm:text-[10px] text-[#c47a6e]">
                {webcamError ||
                  (videoSourceMode === "default"
                    ? "Default clip failed to load — check frontend/public/rov-feed.mp4 exists"
                    : "Video failed to load")}
              </span>
            )}
          </div>
        </div>
      )}

      {libraryOpen && (
        <div className="absolute inset-0 bg-black/70 pointer-events-auto flex items-center justify-center p-3 sm:p-0">
          <div className="w-full max-w-md max-h-[85vh] sm:max-h-[70vh] flex flex-col bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#3a444a]">
              <span className="text-xs uppercase tracking-widest text-[#8fa3ad]">Clip library</span>
              <button
                onClick={() => setLibraryOpen(false)}
                className="text-[#8fa3ad] hover:text-[#d3dbe0] text-sm"
              >
                ✕
              </button>
            </div>

            <div className="flex gap-2 px-4 pt-3">
              <button
                onClick={() => handleSwitchLibraryScope("mine")}
                className={`flex-1 rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest border ${
                  libraryScope === "mine"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                My clips
              </button>
              <button
                onClick={() => handleSwitchLibraryScope("shared")}
                className={`flex-1 rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest border ${
                  libraryScope === "shared"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                Team clips
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
              {libraryLoading && (
                <span className="text-[10px] text-[#5a6a72] uppercase tracking-widest">Loading…</span>
              )}
              {!libraryLoading &&
                (libraryScope === "mine" ? myClips : sharedClips).length === 0 && (
                  <span className="text-[10px] text-[#5a6a72]">
                    {libraryScope === "mine"
                      ? "No saved clips yet — upload a video and hit \"Save to library.\""
                      : "No shared clips yet."}
                  </span>
                )}
              {(libraryScope === "mine" ? myClips : sharedClips).map((clip) => (
                <div
                  key={clip.id}
                  className="flex items-center gap-2 bg-white/[0.04] border border-[#3a444a] hover:border-[#8fa3ad]/60 hover:bg-white/[0.08] rounded-lg overflow-hidden"
                >
                  <button
                    onClick={() => handleLoadClipFromLibrary(clip)}
                    className="flex-1 text-left px-3 py-2"
                  >
                    <p className="text-xs">{clip.name}</p>
                    <p className="text-[10px] text-[#5a6a72]">
                      {libraryScope === "shared" ? clip.owner_email : new Date(clip.created_at).toLocaleDateString()}
                    </p>
                  </button>
                  {clip.owner_email === session?.user?.email && (
                    <button
                      onClick={(e) => handleDeleteClip(clip, e)}
                      title="Delete clip"
                      className="px-3 py-2 text-[#c47a6e] hover:text-[#d99a8f] text-xs"
                    >
                      🗑
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {snapshotLibraryOpen && (
        <div className="absolute inset-0 bg-black/70 pointer-events-auto flex items-center justify-center p-3 sm:p-0">
          <div className="w-full max-w-2xl max-h-[85vh] sm:max-h-[70vh] flex flex-col bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#3a444a]">
              <span className="text-xs uppercase tracking-widest text-[#8fa3ad]">
                Discovery Snapshots
              </span>
              <button
                onClick={() => setSnapshotLibraryOpen(false)}
                className="text-[#8fa3ad] hover:text-[#d3dbe0] text-sm"
              >
                ✕
              </button>
            </div>

            <div className="flex gap-2 px-4 pt-3">
              <button
                onClick={() => handleSwitchSnapshotScope("mine")}
                className={`flex-1 rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest border ${
                  snapshotLibraryScope === "mine"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                Mine
              </button>
              <button
                onClick={() => handleSwitchSnapshotScope("shared")}
                className={`flex-1 rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest border ${
                  snapshotLibraryScope === "shared"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                Team
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              {snapshotLibraryLoading && (
                <span className="text-[10px] text-[#5a6a72] uppercase tracking-widest">
                  Loading…
                </span>
              )}
              {!snapshotLibraryLoading &&
                (snapshotLibraryScope === "mine" ? mySnapshots : sharedSnapshots).length === 0 && (
                  <span className="text-[10px] text-[#5a6a72]">
                    {snapshotLibraryScope === "mine"
                      ? "No snapshots yet — press the gamepad's A button or hit \"Snapshot\" during a live session."
                      : "No team snapshots yet."}
                  </span>
                )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {(snapshotLibraryScope === "mine" ? mySnapshots : sharedSnapshots).map((snap) => (
                  <button
                    key={snap.id}
                    onClick={() => handleViewSnapshot(snap)}
                    className="group relative aspect-video rounded-lg overflow-hidden border border-[#3a444a] hover:border-[#8fa3ad]/60"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={snap.url}
                      alt={snap.species_query || "Discovery snapshot"}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-left">
                      <p className="text-[9px] text-[#d3dbe0] truncate">
                        {snap.species_query || "Unidentified"}
                      </p>
                      <p className="text-[8px] text-[#8fa3ad]">
                        {snap.captured_at ? new Date(snap.captured_at).toLocaleDateString() : ""}
                        {snapshotLibraryScope === "shared" ? ` · ${snap.owner_email}` : ""}
                        {snap.annotated ? " · annotated" : ""}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <SnapshotAnnotator
        open={annotatorOpen}
        mode={annotatorMode}
        imageSrc={annotatorImageSrc}
        telemetry={annotatorTelemetry}
        speciesQuery={annotatorSpeciesQuery}
        ownerEmail={session?.user?.email || ""}
        existingSnapshotId={annotatorExistingId}
        onClose={() => setAnnotatorOpen(false)}
        onSaved={handleSnapshotSaved}
        onDeleted={handleSnapshotDeleted}
      />

      <div className="crt-scanlines absolute inset-0 pointer-events-none opacity-10" />
    </div>
  );
}