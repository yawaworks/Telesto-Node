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
  "https://res.cloudinary.com/YOUR_CLOUD_NAME/video/upload/rov-feed.mp4";

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
  // Gamepad navigation is initialized once (empty-deps effect below), so its
  // onSnapshot callback would otherwise close over whatever `telemetry` was
  // on that first render and never see updates. A ref sidesteps that without
  // re-running gamepad setup on every telemetry tick.
  const telemetryRef = useRef(telemetry);
  useEffect(() => {
    telemetryRef.current = telemetry;
  }, [telemetry]);

  const [speciesQuery, setSpeciesQuery] = useState(DEFAULT_SPECIES);
  const [viewMode, setViewMode] = useState("video");
  const [exportingReport, setExportingReport] = useState(false);
  const [snapshotMessage, setSnapshotMessage] = useState(null);
  // Populated further down (handleDiscoverySnapshot is defined after the
  // video-source handlers). Declared here, before the gamepad-init effect
  // that wires it up, purely for readability — functionally it's safe
  // either way since the effect only dereferences .current() on an actual
  // button press, long after the full component has rendered.
  const handleDiscoverySnapshotRef = useRef(() => {});

  // Video source: "default" (bundled clip) | "upload" (user file) | "webcam" (live camera)
  const [videoSourceMode, setVideoSourceMode] = useState("default");
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState(null);
  const [webcamError, setWebcamError] = useState(null);
  const [videoUrlInput, setVideoUrlInput] = useState("");
  // Separate from webcamError: true whenever the *currently active* video
  // element failed to load, regardless of source mode. Drives the HUD
  // status badge so a broken/missing clip shows "Feed Error" instead of
  // sitting on "Connecting..." forever with no explanation.
  const [videoLoadError, setVideoLoadError] = useState(false);

  // Clip library (Save to Library / My Clips / Team Clips)
  const [uploadedFile, setUploadedFile] = useState(null); // raw File, kept so we can actually upload it on Save
  const [savingClip, setSavingClip] = useState(false);
  const [shareClip, setShareClip] = useState(false);
  const [clipSaveMessage, setClipSaveMessage] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryScope, setLibraryScope] = useState("mine"); // "mine" | "shared"
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

  // Actually apply whichever video source is currently selected. Webcam
  // needs the imperative srcObject API; file/default just use a normal src.
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
      // Route through our backend proxy so hosts that don't allow direct
      // cross-origin canvas capture (most sites, including NOAA's archive)
      // still work without the user needing to download-then-upload.
      video.src = `${API_BASE_URL}/proxy-video?url=${encodeURIComponent(videoUrlInput)}`;
      video.play().catch(() => {});
    } else {
      video.srcObject = null;
      const nextSrc =
        videoSourceMode === "upload" && uploadedVideoUrl ? uploadedVideoUrl : DEFAULT_VIDEO_SRC;
      // External URLs (the Cloudinary-hosted default clip) need crossOrigin
      // set so canvas.toBlob() in useFrameDetection doesn't throw a
      // tainted-canvas security error. Local blob: URLs (uploaded files)
      // are same-origin and don't need it, but setting it is harmless.
      if (nextSrc.startsWith("http")) {
        video.crossOrigin = "anonymous";
      } else {
        video.removeAttribute("crossorigin");
      }
      video.src = nextSrc;
      video.play().catch(() => {});
    }
  }, [videoSourceMode, uploadedVideoUrl, videoUrlInput]);

  // Clean up webcam tracks whenever we leave webcam mode or unmount
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

      setClipSaveMessage({ type: "success", text: shareClip ? "Saved to Team Clips" : "Saved to My Clips" });
      // Once saved, this exact file object is no longer needed for another
      // save — but keep it playable, just prevent double-saving by accident.
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
    e.stopPropagation(); // don't trigger handleLoadClipFromLibrary on the same click
    if (!window.confirm(`Delete "${clip.name}"? This can't be undone.`)) return;

    try {
      const params = new URLSearchParams({ owner_email: session?.user?.email || "" });
      const response = await fetch(`${API_BASE_URL}/clips/${clip.id}?${params}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`Delete failed: ${response.status}`);

      // Remove it from whichever list(s) currently hold it locally, rather
      // than re-fetching — a shared clip you own could be sitting in both
      // "mine" and "shared" caches at once.
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
      // Auto-dismiss the toast after a few seconds either way
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

  const isMapMode = viewMode === "map";

  if (sessionStatus === "unauthenticated") {
    return null; // redirect to /login is already in flight via the effect above
  }

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black text-cyan-200">
      {sessionStatus === "loading" && (
        // Overlay, not an early-return swap of the whole tree — the <video>
        // below must mount on the FIRST real render, otherwise the
        // source-setting useEffect (deps: videoSourceMode/uploadedVideoUrl/
        // videoUrlInput) runs once while videoRef.current is still null,
        // bails out silently, and then never runs again once the video
        // element actually exists (those deps never change between the
        // "loading" and "authenticated" states) — leaving <video> with no
        // src forever. Keeping <video> mounted the whole time avoids that.
        <div className="absolute inset-0 z-50 bg-black flex items-center justify-center font-mono text-sm">
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
          // Fires for ANY source mode now — previously this only reported
          // errors when videoSourceMode === "url", so a missing/broken
          // default clip (frontend/public/rov-feed.mp4) or a broken
          // uploaded file failed completely silently, leaving the HUD
          // stuck showing "Connecting..." forever with no explanation.
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

      {/* Hidden file input, triggered by the Upload Video button */}
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
        <div className="absolute top-4 left-4 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-4 py-2 shadow-[0_0_15px_rgba(34,211,238,0.25)]">
          <p className="text-xs uppercase tracking-widest text-cyan-400">Depth</p>
          <p className="text-2xl font-bold">{telemetry.depth}</p>
        </div>

        <div className="absolute top-4 right-4 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-4 py-2 text-right">
          <p className="text-xs uppercase tracking-widest text-cyan-400">Coordinates</p>
          <p className="text-sm">{telemetry.coords}</p>
        </div>

        <div className="absolute top-4 right-4 translate-y-16 pointer-events-auto backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-3 py-1 flex items-center gap-2 text-[10px]">
          <span className="text-cyan-400/70">{session?.user?.email || session?.user?.name}</span>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="uppercase tracking-widest text-red-400 hover:text-red-300"
          >
            Sign Out
          </button>
        </div>

        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto flex gap-2">
          <button
            onClick={() => setViewMode("video")}
            className={`backdrop-blur-md border rounded-xl px-4 py-1 text-xs uppercase tracking-widest ${
              !isMapMode
                ? "bg-cyan-400/20 border-cyan-400/60"
                : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
            }`}
          >
            ROV Feed
          </button>
          <button
            onClick={() => setViewMode("map")}
            className={`backdrop-blur-md border rounded-xl px-4 py-1 text-xs uppercase tracking-widest ${
              isMapMode
                ? "bg-cyan-400/20 border-cyan-400/60"
                : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
            }`}
          >
            Bathymetry Map
          </button>
        </div>

        {!isMapMode && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-4 py-1 flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                videoLoadError
                  ? "bg-red-400"
                  : status === "live"
                  ? "bg-green-400 animate-pulse"
                  : status === "error"
                  ? "bg-red-400"
                  : "bg-yellow-400 animate-pulse"
              }`}
            />
            <span className="text-xs uppercase tracking-widest">
              {videoLoadError
                ? "Feed Error — Check Video Source"
                : status === "live"
                ? "Inference Live"
                : status === "error"
                ? "Inference Error"
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
              className="backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-lg px-3 py-1 text-xs text-cyan-200 placeholder:text-cyan-200/40 outline-none focus:border-cyan-400/70 w-64"
            />
            <button
              type="submit"
              className="backdrop-blur-md bg-cyan-400/10 border border-cyan-400/30 rounded-lg px-3 py-1 text-xs uppercase tracking-widest hover:bg-cyan-400/20"
            >
              Plot
            </button>
          </form>
        )}

        {/* Video source controls — only relevant in ROV Feed mode */}
        {!isMapMode && (
          <div className="absolute bottom-20 left-4 pointer-events-auto flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                onClick={handleUseDefaultClip}
                className={`backdrop-blur-md border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest ${
                  videoSourceMode === "default"
                    ? "bg-cyan-400/20 border-cyan-400/60"
                    : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
                }`}
              >
                Default Clip
              </button>
              <button
                onClick={handleUploadClick}
                className={`backdrop-blur-md border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest ${
                  videoSourceMode === "upload"
                    ? "bg-cyan-400/20 border-cyan-400/60"
                    : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
                }`}
              >
                Upload Video
              </button>
              <button
                onClick={handleUseWebcam}
                className={`backdrop-blur-md border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest ${
                  videoSourceMode === "webcam"
                    ? "bg-cyan-400/20 border-cyan-400/60"
                    : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
                }`}
              >
                Use Webcam
              </button>
              <button
                onClick={handleOpenLibrary}
                className="backdrop-blur-md border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest bg-white/5 border-cyan-400/30 hover:bg-white/10"
              >
                📁 Clip Library
              </button>
            </div>

            {videoSourceMode === "upload" && uploadedFile && (
              <div className="flex items-center gap-2 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-lg px-2 py-1">
                <label className="flex items-center gap-1 text-[10px] text-cyan-200/80 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shareClip}
                    onChange={(e) => setShareClip(e.target.checked)}
                    className="accent-cyan-400"
                  />
                  Share with team
                </label>
                <button
                  onClick={handleSaveToLibrary}
                  disabled={savingClip}
                  className="text-[10px] uppercase tracking-widest text-cyan-300 hover:text-cyan-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingClip ? "Saving…" : "Save to Library"}
                </button>
              </div>
            )}

            {clipSaveMessage && (
              <span
                className={`text-[10px] rounded px-2 py-1 bg-black/40 ${
                  clipSaveMessage.type === "success" ? "text-green-400" : "text-red-400"
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
                className="backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-lg px-2 py-1 text-[10px] text-cyan-200 placeholder:text-cyan-200/40 outline-none focus:border-cyan-400/70 w-56"
              />
              <button
                type="submit"
                className={`backdrop-blur-md border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest ${
                  videoSourceMode === "url"
                    ? "bg-cyan-400/20 border-cyan-400/60"
                    : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
                }`}
              >
                Load URL
              </button>
            </form>
            {(webcamError || (videoLoadError && videoSourceMode !== "url")) && (
              <span className="text-[10px] text-red-400 bg-black/40 rounded px-2 py-1">
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
          className="absolute top-4 right-4 translate-y-32 pointer-events-auto backdrop-blur-md bg-cyan-400/10 border border-cyan-400/40 rounded-xl px-4 py-2 text-xs uppercase tracking-widest hover:bg-cyan-400/20"
        >
          📸 Snapshot
        </button>

        <button
          onClick={handleExportReport}
          disabled={exportingReport}
          className="absolute top-4 right-56 pointer-events-auto backdrop-blur-md bg-cyan-400/10 border border-cyan-400/40 rounded-xl px-4 py-2 text-xs uppercase tracking-widest hover:bg-cyan-400/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {exportingReport ? (
            <>
              <span className="w-2 h-2 rounded-full bg-cyan-300 animate-pulse" />
              Generating…
            </>
          ) : (
            <>Export Field Report</>
          )}
        </button>

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-6 py-2 flex gap-6">
          <span>
            TEMP <span className="text-cyan-300">{telemetry.temp}</span>
            {telemetry.tempSource === "live" && (
              <span className="ml-1 text-[10px] text-green-400 align-super">LIVE</span>
            )}
          </span>
          <span>
            SALINITY <span className="text-cyan-300">{telemetry.salinity}</span>
          </span>
          <span>
            HEADING <span className="text-cyan-300">{telemetry.heading}</span>
          </span>
          {!isMapMode && coralBleachingRatio !== null && (
            <span>
              CORAL{" "}
              <span className={alert ? "text-red-400" : "text-cyan-300"}>
                {(coralBleachingRatio * 100).toFixed(0)}% bleached
              </span>
            </span>
          )}
        </div>

        {!isMapMode && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 border border-cyan-400/60 rounded-full animate-pulse" />
        )}

        {!isMapMode && alert && (
          <div className="absolute bottom-4 right-4 backdrop-blur-md bg-red-500/10 border border-red-400/50 text-red-300 rounded-xl px-4 py-2 animate-pulse">
            ⚠ Coral Bleaching Detected
          </div>
        )}

        {snapshotMessage && (
          <div
            className={`absolute top-1/2 left-1/2 -translate-x-1/2 translate-y-24 backdrop-blur-md border rounded-xl px-4 py-2 text-xs uppercase tracking-widest ${
              snapshotMessage.type === "success"
                ? "bg-green-400/10 border-green-400/50 text-green-300"
                : snapshotMessage.type === "error"
                ? "bg-red-500/10 border-red-400/50 text-red-300"
                : "bg-white/5 border-cyan-400/30 text-cyan-200"
            }`}
          >
            {snapshotMessage.text}
          </div>
        )}

        {libraryOpen && (
          <div className="absolute inset-0 bg-black/70 pointer-events-auto flex items-center justify-center">
            <div className="w-full max-w-md max-h-[70vh] flex flex-col backdrop-blur-md bg-black/80 border border-cyan-400/40 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-400/20">
                <span className="text-xs uppercase tracking-widest text-cyan-400">Clip Library</span>
                <button
                  onClick={() => setLibraryOpen(false)}
                  className="text-cyan-400/70 hover:text-cyan-200 text-sm"
                >
                  ✕
                </button>
              </div>

              <div className="flex gap-2 px-4 pt-3">
                <button
                  onClick={() => handleSwitchLibraryScope("mine")}
                  className={`flex-1 rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest border ${
                    libraryScope === "mine"
                      ? "bg-cyan-400/20 border-cyan-400/60"
                      : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
                  }`}
                >
                  My Clips
                </button>
                <button
                  onClick={() => handleSwitchLibraryScope("shared")}
                  className={`flex-1 rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest border ${
                    libraryScope === "shared"
                      ? "bg-cyan-400/20 border-cyan-400/60"
                      : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
                  }`}
                >
                  Team Clips
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
                {libraryLoading && (
                  <span className="text-[10px] text-cyan-200/60 uppercase tracking-widest">Loading…</span>
                )}
                {!libraryLoading &&
                  (libraryScope === "mine" ? myClips : sharedClips).length === 0 && (
                    <span className="text-[10px] text-cyan-200/60">
                      {libraryScope === "mine"
                        ? "No saved clips yet — upload a video and hit \"Save to Library\"."
                        : "No shared clips yet."}
                    </span>
                  )}
                {(libraryScope === "mine" ? myClips : sharedClips).map((clip) => (
                  <div
                    key={clip.id}
                    className="flex items-center gap-2 backdrop-blur-md bg-white/5 border border-cyan-400/20 hover:border-cyan-400/60 hover:bg-white/10 rounded-lg overflow-hidden"
                  >
                    <button
                      onClick={() => handleLoadClipFromLibrary(clip)}
                      className="flex-1 text-left px-3 py-2"
                    >
                      <p className="text-xs text-cyan-200">{clip.name}</p>
                      <p className="text-[10px] text-cyan-200/50">
                        {libraryScope === "shared" ? clip.owner_email : new Date(clip.created_at).toLocaleDateString()}
                      </p>
                    </button>
                    {clip.owner_email === session?.user?.email && (
                      <button
                        onClick={(e) => handleDeleteClip(clip, e)}
                        title="Delete clip"
                        className="px-3 py-2 text-red-400/70 hover:text-red-300 text-xs"
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