"use client";

import { useEffect, useRef, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { initGamepadNavigation } from "../lib/gamepad-controller";
import { initBathymetryMap } from "../lib/bathymetry-map";
import { loadSpeciesMarkers } from "../lib/species-markers";
import { useFrameDetection } from "../lib/useFrameDetection";
import { useTelemetry } from "../lib/useTelemetry";
import DetectionOverlay from "../components/DetectionOverlay";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const BLEACHING_ALERT_THRESHOLD = 0.4;
const DEFAULT_SPECIES = "Acropora cervicornis";
// Hosted on Cloudinary instead of committed to the repo — a demo-length
// video file is too large to check into GitHub sensibly, and this way it
// can be swapped without a redeploy. Replace with your own upload's URL.
const DEFAULT_VIDEO_SRC =
  process.env.NEXT_PUBLIC_DEFAULT_VIDEO_URL ||
  "https://res.cloudinary.com/YOUR_CLOUD_NAME/videohttps://res.cloudinary.com/oimv0zhu/video/upload/v1785200530/12142670-hd_1920_1080_30fps_inpvjc.mp4/upload/rov-feed.mp4";
// n8n "Mission Report Email" workflow's production webhook URL.
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

  const { boxes, coralBleachingRatio, status } = useFrameDetection(videoRef, {
    enabled: viewMode === "video" && !videoLoadError,
    telemetry,
  });
  const alert =
    coralBleachingRatio !== null && coralBleachingRatio >= BLEACHING_ALERT_THRESHOLD;

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

      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.92)
      );
      if (!blob) throw new Error("Failed to capture frame");

      const formData = new FormData();
      formData.append("file", blob, `discovery-${Date.now()}.jpg`);

      const t = telemetryRef.current;
      const params = new URLSearchParams({
        depth: t.depth || "",
        coords: t.coords || "",
        temp: t.temp || "",
        salinity: t.salinity || "",
        heading: t.heading || "",
        species_query: speciesQuery || "",
      });

      setSnapshotMessage({ type: "pending", text: "Saving snapshot…" });

      const response = await fetch(`${API_BASE_URL}/snapshot?${params}`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error(`Snapshot upload failed: ${response.status}`);

      const data = await response.json();
      setSnapshotMessage({
        type: "success",
        text: data.saved_to_db ? "Snapshot saved" : "Snapshot saved (offline log unavailable)",
      });
    } catch (err) {
      console.error("Discovery Snapshot failed:", err);
      setSnapshotMessage({ type: "error", text: "Snapshot failed — check connection" });
    } finally {
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

  if (sessionStatus === "unauthenticated") {
    return null;
  }

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#171d20] text-[#d3dbe0] font-mono">
      {sessionStatus === "loading" && (
        <div className="absolute inset-0 z-50 bg-[#171d20] flex items-center justify-center text-sm text-[#d3dbe0]">
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

      <DetectionOverlay videoRef={videoRef} boxes={isMapMode ? [] : boxes} />

      <div
        ref={mapContainerRef}
        className="absolute inset-0 w-full h-full"
        style={{
          opacity: isMapMode ? 1 : 0,
          pointerEvents: isMapMode ? "auto" : "none",
        }}
      />

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-4 left-4 bg-white/[0.04] border border-[#3a444a] rounded-xl px-4 py-2">
          <p className="text-[10px] uppercase tracking-widest text-[#a48a55]">Depth · simulated</p>
          <p className="text-2xl font-bold text-[#d3dbe0]">{telemetry.depth}</p>
        </div>

        <div className="absolute top-4 right-4 bg-white/[0.04] border border-[#3a444a] rounded-xl px-4 py-2 text-right">
          <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Coordinates · measured</p>
          <p className="text-sm text-[#d3dbe0]">{telemetry.coords}</p>
        </div>

        <div className="absolute top-4 right-4 translate-y-16 pointer-events-auto bg-white/[0.04] border border-[#3a444a] rounded-xl px-3 py-1 flex items-center gap-2 text-[10px]">
          <span className="text-[#8fa3ad]">{session?.user?.email || session?.user?.name}</span>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="uppercase tracking-widest text-[#c47a6e] hover:text-[#d99a8f]"
          >
            Sign out
          </button>
        </div>

        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto flex gap-2">
          <button
            onClick={() => setViewMode("video")}
            className={`border rounded-xl px-4 py-1 text-xs uppercase tracking-widest ${
              !isMapMode
                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
            }`}
          >
            ROV feed
          </button>
          <button
            onClick={() => setViewMode("map")}
            className={`border rounded-xl px-4 py-1 text-xs uppercase tracking-widest ${
              isMapMode
                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
            }`}
          >
            Bathymetry map
          </button>
        </div>

        {!isMapMode && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-white/[0.04] border border-[#3a444a] rounded-xl px-4 py-1 flex items-center gap-2">
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
            <span className="text-xs uppercase tracking-widest text-[#d3dbe0]">
              {videoLoadError
                ? "Feed error — check video source"
                : status === "live"
                ? "Inference live"
                : status === "error"
                ? "Inference error"
                : "Connecting…"}
            </span>
          </div>
        )}

        {isMapMode && (
          <form
            onSubmit={handleSpeciesSearch}
            className="absolute top-16 left-1/2 -translate-x-1/2 pointer-events-auto flex gap-2"
          >
            <input
              type="text"
              value={speciesQuery}
              onChange={(e) => setSpeciesQuery(e.target.value)}
              placeholder="Scientific name (e.g. Acropora cervicornis)"
              className="bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-1 text-xs text-[#d3dbe0] placeholder:text-[#5a6a72] outline-none focus:border-[#8fa3ad] w-64"
            />
            <button
              type="submit"
              className="bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-lg px-3 py-1 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20"
            >
              Plot
            </button>
          </form>
        )}

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

        {!isMapMode && (
          <div className="absolute bottom-20 left-4 pointer-events-auto flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                onClick={handleUseDefaultClip}
                className={`border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest ${
                  videoSourceMode === "default"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                Default clip
              </button>
              <button
                onClick={handleUploadClick}
                className={`border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest ${
                  videoSourceMode === "upload"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                Upload video
              </button>
              <button
                onClick={handleUseWebcam}
                className={`border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest ${
                  videoSourceMode === "webcam"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                Use webcam
              </button>
              <button
                onClick={handleOpenLibrary}
                className="border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
              >
                Clip library
              </button>
            </div>

            {videoSourceMode === "upload" && uploadedFile && (
              <div className="flex items-center gap-2 bg-white/[0.04] border border-[#3a444a] rounded-lg px-2 py-1">
                <label className="flex items-center gap-1 text-[10px] text-[#b7c4cc] cursor-pointer">
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
                  className="text-[10px] uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingClip ? "Saving…" : "Save to library"}
                </button>
              </div>
            )}

            {clipSaveMessage && (
              <span
                className={`text-[10px] rounded px-2 py-1 bg-black/40 ${
                  clipSaveMessage.type === "success" ? "text-[#8fa3ad]" : "text-[#c47a6e]"
                }`}
              >
                {clipSaveMessage.text}
              </span>
            )}
            <form onSubmit={handleUseVideoUrl} className="flex gap-2">
              <input
                type="text"
                value={videoUrlInput}
                onChange={(e) => setVideoUrlInput(e.target.value)}
                placeholder="Paste a direct .mp4 video URL…"
                className="bg-white/[0.04] border border-[#3a444a] rounded-lg px-2 py-1 text-[10px] text-[#d3dbe0] placeholder:text-[#5a6a72] outline-none focus:border-[#8fa3ad] w-56"
              />
              <button
                type="submit"
                className={`border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest ${
                  videoSourceMode === "url"
                    ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                    : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                }`}
              >
                Load URL
              </button>
            </form>
            {(webcamError || (videoLoadError && videoSourceMode !== "url")) && (
              <span className="text-[10px] text-[#c47a6e] bg-black/40 rounded px-2 py-1">
                {webcamError ||
                  (videoSourceMode === "default"
                    ? "Default clip failed to load — check frontend/public/rov-feed.mp4 exists"
                    : "Video failed to load")}
              </span>
            )}
          </div>
        )}

        <button
          onClick={handleDiscoverySnapshot}
          className="absolute top-4 right-4 translate-y-32 pointer-events-auto bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-xl px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20"
        >
          Snapshot
        </button>

        <button
          onClick={handleExportReport}
          disabled={exportingReport}
          className="absolute top-4 right-56 pointer-events-auto bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-xl px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {exportingReport ? (
            <>
              <span className="w-2 h-2 rounded-full bg-[#8fa3ad] animate-pulse" />
              Generating…
            </>
          ) : (
            <>Export field report</>
          )}
        </button>

        <button
          onClick={handleEmailReport}
          disabled={emailingReport}
          className="absolute top-4 right-[420px] pointer-events-auto bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-xl px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {emailingReport ? (
            <>
              <span className="w-2 h-2 rounded-full bg-[#8fa3ad] animate-pulse" />
              Sending…
            </>
          ) : (
            <>Email report</>
          )}
        </button>

        {emailReportMessage && (
          <div
            className={`absolute top-16 right-4 border rounded-xl px-4 py-2 text-xs uppercase tracking-widest ${
              emailReportMessage.type === "success"
                ? "bg-[#8fa3ad]/10 border-[#8fa3ad]/50 text-[#b7c4cc]"
                : "bg-[#c47a6e]/10 border-[#c47a6e]/50 text-[#d99a8f]"
            }`}
          >
            {emailReportMessage.text}
          </div>
        )}

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/[0.04] border border-[#3a444a] rounded-xl px-6 py-2 flex gap-6">
          <span>
            <span className="text-[9px] text-[#8fa3ad] tracking-wide">TEMP</span>{" "}
            <span className="text-[#d3dbe0]">{telemetry.temp}</span>
            {telemetry.tempSource === "live" && (
              <span className="ml-1 text-[9px] text-[#8fa3ad] align-super">measured</span>
            )}
          </span>
          <span>
            <span className="text-[9px] text-[#a48a55] tracking-wide">SALINITY</span>{" "}
            <span className="text-[#a48a55] border-b border-dashed border-[#a48a55]">{telemetry.salinity}</span>
          </span>
          <span>
            <span className="text-[9px] text-[#a48a55] tracking-wide">HEADING</span>{" "}
            <span className="text-[#a48a55] border-b border-dashed border-[#a48a55]">{telemetry.heading}</span>
          </span>
          {!isMapMode && coralBleachingRatio !== null && (
            <span>
              <span className="text-[9px] text-[#d8b877] tracking-wide">CORAL · unvalidated model</span>{" "}
              <span className={alert ? "text-[#d8b877]" : "text-[#d3dbe0]"}>
                {(coralBleachingRatio * 100).toFixed(0)}% bleached
              </span>
            </span>
          )}
        </div>

        {!isMapMode && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 border border-[#8fa3ad]/60 rounded-full animate-pulse" />
        )}

        {!isMapMode && alert && (
          <div className="absolute bottom-4 right-4 bg-[#a48a55]/10 border border-[#b38d47] text-[#d8b877] rounded-xl px-4 py-2">
            Possible bleaching — unverified
          </div>
        )}

        {snapshotMessage && (
          <div
            className={`absolute top-1/2 left-1/2 -translate-x-1/2 translate-y-24 border rounded-xl px-4 py-2 text-xs uppercase tracking-widest ${
              snapshotMessage.type === "success"
                ? "bg-[#8fa3ad]/10 border-[#8fa3ad]/50 text-[#b7c4cc]"
                : snapshotMessage.type === "error"
                ? "bg-[#c47a6e]/10 border-[#c47a6e]/50 text-[#d99a8f]"
                : "bg-white/[0.04] border-[#3a444a] text-[#d3dbe0]"
            }`}
          >
            {snapshotMessage.text}
          </div>
        )}

        {libraryOpen && (
          <div className="absolute inset-0 bg-black/70 pointer-events-auto flex items-center justify-center">
            <div className="w-full max-w-md max-h-[70vh] flex flex-col bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
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
                      ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                      : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
                  }`}
                >
                  My clips
                </button>
                <button
                  onClick={() => handleSwitchLibraryScope("shared")}
                  className={`flex-1 rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest border ${
                    libraryScope === "shared"
                      ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
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
                      <p className="text-xs text-[#d3dbe0]">{clip.name}</p>
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
      </div>

      <div className="crt-scanlines absolute inset-0 pointer-events-none opacity-10" />
    </div>
  );
}