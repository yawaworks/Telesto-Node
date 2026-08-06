"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { initGamepadNavigation } from "../lib/gamepad-controller";
import { initBathymetryMap } from "../lib/bathymetry-map";
import { loadSpeciesMarkers, filterMarkersByMonth } from "../lib/species-markers";
import HabitatTrendPanel from "./HabitatTrendPanel";
import { loadVesselActivity, clearVesselActivity } from "../lib/vessel-layer";
import { useFrameDetection, DEFAULT_CONF_THRESHOLD } from "../lib/useFrameDetection";
import { useTelemetry } from "../lib/useTelemetry";
import DetectionOverlay from "./DetectionOverlay";
import BioacousticsPanel from "./BioacousticsPanel";
import FieldTranslator from "./FieldTranslator";
import SnapshotAnnotator from "./SnapshotAnnotator";
import OfflineStatusBadge from "./OfflineStatusBadge";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const BLEACHING_ALERT_THRESHOLD = 0.4;
const DEFAULT_SPECIES = "Acropora cervicornis";
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DEFAULT_VIDEO_SRC =
  process.env.NEXT_PUBLIC_DEFAULT_VIDEO_URL ||
  "https://res.cloudinary.com/YOUR_CLOUD_NAME/video/upload/rov-feed.mp4";

export default function MissionControl({ embedded = false, channelId = null } = {}) {
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
  const diveLogInputRef = useRef(null);
  const webcamStreamRef = useRef(null);

  const { telemetry } = useTelemetry();
  const telemetryRef = useRef(telemetry);
  useEffect(() => {
    telemetryRef.current = telemetry;
  }, [telemetry]);

  const [speciesQuery, setSpeciesQuery] = useState(DEFAULT_SPECIES);
  // Real, operator-derived heading — updated directly by actual gamepad
  // steering input (see gamepad-controller.js), not synthetic server-side
  // drift. Starts null so the UI can fall back to the backend's simulated
  // heading until the operator actually steers for the first time.
  const [operatorHeading, setOperatorHeading] = useState(null);
  // Feedback for the live species search — "idle" | "loading" | "success"
  // | "empty" | "error". Previously a search gave zero visible feedback:
  // it could succeed, fail, or find nothing, and the map would just sit
  // there unchanged either way.
  const [speciesSearchStatus, setSpeciesSearchStatus] = useState("idle");
  // Seasonal-occurrence month filter for the currently plotted species —
  // null means "show all months". Only surfaced in the UI when the
  // current result set actually has dated records to filter (see
  // monthsAvailable from loadSpeciesMarkers's return value).
  const [monthsAvailable, setMonthsAvailable] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(null);
  // { latitude, longitude } | null — centered on the map's current view
  // at the moment the button is pressed, not live-updated as the map pans.
  const [habitatTrendCenter, setHabitatTrendCenter] = useState(null);
  const [vesselLayerOn, setVesselLayerOn] = useState(false);
  const [vesselStatus, setVesselStatus] = useState("idle");
  const [fieldTranslatorOpen, setFieldTranslatorOpen] = useState(false);
  const [speciesResultCount, setSpeciesResultCount] = useState(0);
  const speciesSearchDebounceRef = useRef(null);
  // Guards against an older, slower request's response landing AFTER a
  // newer search has already started — without this, typing quickly
  // could show stale results if an earlier request resolves last.
  const speciesSearchSeqRef = useRef(0);
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
  const [videoGpsInfo, setVideoGpsInfo] = useState(null);

  const [uploadedFile, setUploadedFile] = useState(null);
  const [savingClip, setSavingClip] = useState(false);
  const [shareClip, setShareClip] = useState(false);
  const [clipSaveMessage, setClipSaveMessage] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryScope, setLibraryScope] = useState("mine");
  const [myClips, setMyClips] = useState([]);
  const [sharedClips, setSharedClips] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const [diveLogId, setDiveLogId] = useState(null);
  const [diveLogSampleCount, setDiveLogSampleCount] = useState(0);
  const [diveLogSample, setDiveLogSample] = useState(null);

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

  // Minimum model confidence (0-1) a detection needs to be shown/logged at
  // all. Exposed as a slider in the actions panel — lower catches more
  // (noisier) detections, higher shows only the model's most confident
  // calls. Session-only by design, same as the rest of this panel's
  // controls; it doesn't persist across reloads.
  const [confThreshold, setConfThreshold] = useState(DEFAULT_CONF_THRESHOLD);

  // "mine" vs "team" scoping for exported/emailed mission reports — see
  // app/report.py. Defaults to "mine" so a researcher's export only ever
  // reflects their own dive unless they deliberately ask for the pooled
  // team-wide view.
  const [reportScope, setReportScope] = useState("mine");

  const { boxes, ghostBoxes, coralBleachingRatio, opticalFlow, status } = useFrameDetection(videoRef, {
    enabled: viewMode === "video" && !videoLoadError,
    telemetry,
    alertEmail: session?.user?.email,
    ownerEmail: session?.user?.email,
    confThreshold,
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
      onHeadingUpdate: setOperatorHeading,
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

    // The backend's optical-flow estimator compares each new frame to
    // the previous one it saw — without this, switching sources (e.g.
    // default clip -> upload) would compare the first frame of the new
    // clip against the last frame of the old one and report meaningless
    // motion for a frame. Fire-and-forget: a failed reset just means one
    // stale-looking motion reading, not worth blocking on.
    fetch(`${API_BASE_URL}/reset-motion-tracking`, { method: "POST" }).catch(() => {});
  }, [videoSourceMode, uploadedVideoUrl, videoUrlInput]);

  useEffect(() => {
    return () => {
      webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (speciesSearchDebounceRef.current) {
        clearTimeout(speciesSearchDebounceRef.current);
      }
    };
  }, []);

  // Poll dive log for current playback position
  useEffect(() => {
    if (!diveLogId) {
      setDiveLogSample(null);
      return;
    }

    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;

      const elapsedSeconds = video.currentTime || 0;
      fetch(`${API_BASE_URL}/dive-log/${diveLogId}/at?elapsed_seconds=${elapsedSeconds}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && !data.error) {
            setDiveLogSample(data);
          }
        })
        .catch(() => {});
    }, 500);

    return () => clearInterval(interval);
  }, [diveLogId]);

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
    setVideoGpsInfo(null);

    const formData = new FormData();
    formData.append("file", file);
    fetch(`${API_BASE_URL}/extract-video-metadata`, { method: "POST", body: formData })
      .then((r) => r.json())
      .then((data) => {
        if (data.has_telemetry) {
          setVideoGpsInfo(`Real GPS track detected — ${data.point_count} points from camera metadata`);
        }
      })
      .catch(() => {});
  }

  async function handleDiveLogSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    const params = new URLSearchParams({ owner_email: session?.user?.email || "" });
    const res = await fetch(`${API_BASE_URL}/dive-log?${params}`, { method: "POST", body: formData });
    if (res.ok) {
      const data = await res.json();
      setDiveLogId(data.id);
      setDiveLogSampleCount(data.sample_count);
    }
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
      const detectedLabel = boxesRef.current?.[0]?.label;

      const activeDepth = diveLogSample?.depth_m !== undefined
        ? `${diveLogSample.depth_m.toFixed(1)} m`
        : t.depth || "";
      const activeTemp = diveLogSample?.temp_c !== undefined
        ? `${diveLogSample.temp_c.toFixed(1)} °C`
        : t.temp || "";

      setAnnotatorMode("new");
      setAnnotatorImageSrc(dataUrl);
      setAnnotatorTelemetry({
        depth: activeDepth,
        coords: t.coords || "",
        temp: activeTemp,
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

  async function runSpeciesSearch(query) {
    if (!mapRef.current || !query?.trim()) return;

    const seq = ++speciesSearchSeqRef.current;
    setSpeciesSearchStatus("loading");
    setSelectedMonth(null); // new search — drop any month filter from the previous species
    setMonthsAvailable(false);

    const result = await loadSpeciesMarkers(mapRef.current, query.trim());

    if (seq !== speciesSearchSeqRef.current) return;

    setSpeciesSearchStatus(result.status);
    setSpeciesResultCount(result.count || 0);
    setMonthsAvailable(!!result.monthsAvailable);
  }

  function handleMonthFilterChange(month) {
    setSelectedMonth(month);
    if (!mapRef.current) return;
    const result = filterMarkersByMonth(mapRef.current, month);
    setSpeciesResultCount(result.count);
  }

  function handleOpenHabitatTrend() {
    if (!mapRef.current) return;
    const center = mapRef.current.getCenter();
    setHabitatTrendCenter({ latitude: center.lat, longitude: center.lng });
  }

  async function handleToggleVesselLayer() {
    if (!mapRef.current) return;

    if (vesselLayerOn) {
      clearVesselActivity(mapRef.current);
      setVesselLayerOn(false);
      setVesselStatus("idle");
      return;
    }

    setVesselStatus("loading");
    const bounds = mapRef.current.getBounds();
    // Last 90 days by default — recent-enough activity to be relevant to
    // a live mission without pulling a huge date range on first load.
    const end = new Date();
    const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
    const result = await loadVesselActivity(
      mapRef.current,
      {
        minLat: bounds.getSouth(),
        minLng: bounds.getWest(),
        maxLat: bounds.getNorth(),
        maxLng: bounds.getEast(),
      },
      { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
    );
    setVesselStatus(result.status);
    setVesselLayerOn(result.status === "success" || result.status === "empty");
  }

  function handleSpeciesQueryChange(value) {
    setSpeciesQuery(value);

    if (speciesSearchDebounceRef.current) {
      clearTimeout(speciesSearchDebounceRef.current);
    }
    if (!value.trim()) {
      setSpeciesSearchStatus("idle");
      return;
    }
    speciesSearchDebounceRef.current = setTimeout(() => {
      runSpeciesSearch(value);
    }, 450);
  }

  function handleSpeciesSearch(e) {
    e.preventDefault();
    if (speciesSearchDebounceRef.current) {
      clearTimeout(speciesSearchDebounceRef.current);
    }
    runSpeciesSearch(speciesQuery);
  }

  function handleViewDistribution(scientificName) {
    setViewMode("map");
    setSpeciesQuery(scientificName);
    runSpeciesSearch(scientificName);
  }

  async function handleExportReport() {
    setExportingReport(true);
    try {
      const activeTelemetry = {
        ...telemetry,
        depth: diveLogSample?.depth_m !== undefined ? `${diveLogSample.depth_m.toFixed(1)} m` : telemetry.depth,
        temp: diveLogSample?.temp_c !== undefined ? `${diveLogSample.temp_c.toFixed(1)} °C` : telemetry.temp,
      };
      // "mine" is meaningless without a signed-in identity to scope to —
      // fall back to "team" rather than sending a scope=mine request the
      // backend will reject with a 400.
      const effectiveScope = reportScope === "mine" && !session?.user?.email ? "team" : reportScope;
      const params = new URLSearchParams({
        ...activeTelemetry,
        scope: effectiveScope,
        ...(session?.user?.email ? { owner_email: session.user.email } : {}),
      });
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
      const activeTelemetry = {
        ...telemetry,
        depth: diveLogSample?.depth_m !== undefined ? `${diveLogSample.depth_m.toFixed(1)} m` : telemetry.depth,
        temp: diveLogSample?.temp_c !== undefined ? `${diveLogSample.temp_c.toFixed(1)} °C` : telemetry.temp,
      };
      const response = await fetch(`${API_BASE_URL}/send-mission-report-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...activeTelemetry,
          recipient_email: recipientEmail,
          scope: reportScope,
          owner_email: recipientEmail,
        }),
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
  const isAcousticsMode = viewMode === "acoustics";
  const isVideoMode = viewMode === "video";

  const activeToast = emailReportMessage || snapshotMessage;

  if (sessionStatus === "unauthenticated") {
    return null;
  }

  return (
    <div
      className={`relative w-full overflow-hidden bg-[#171d20] text-[#d3dbe0] font-mono text-sm ${
        embedded ? "h-full" : "h-screen"
      }`}
    >
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
        style={{ opacity: isVideoMode ? 1 : 0 }}
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
        boxes={isVideoMode ? boxes : []}
        ghostBoxes={isVideoMode ? ghostBoxes : []}
        onViewDistribution={handleViewDistribution}
      />

      <div
        ref={mapContainerRef}
        className="absolute inset-0 w-full h-full"
        style={{
          opacity: isMapMode ? 1 : 0,
          pointerEvents: isMapMode ? "auto" : "none",
        }}
      />

      {isAcousticsMode && (
        <div className="absolute inset-0 w-full h-full bg-[#12171a] pt-14 pointer-events-auto">
          <BioacousticsPanel channelId={channelId} currentEmail={session?.user?.email} />
        </div>
      )}

      <div className="absolute top-0 left-0 right-0 h-14 flex items-center justify-between gap-1 px-2 sm:px-4 bg-[#1c2226]/90 border-b border-[#3a444a] pointer-events-auto overflow-x-auto">
        <div className="flex gap-1 sm:gap-2 shrink-0">
          <button
            onClick={() => setViewMode("video")}
            className={`border rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest whitespace-nowrap ${
              isVideoMode
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
          <button
            onClick={() => setViewMode("acoustics")}
            className={`border rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest whitespace-nowrap ${
              isAcousticsMode
                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
            }`}
          >
            <span className="sm:hidden">Audio</span>
            <span className="hidden sm:inline">Bioacoustics</span>
          </button>
        </div>

        <div className="hidden sm:flex items-center gap-2 shrink-0">
          {isVideoMode && (
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
          )}
          {isMapMode && <span className="text-xs uppercase tracking-widest text-[#5a6a72]">Map mode</span>}
          {isAcousticsMode && (
            <span className="text-xs uppercase tracking-widest text-[#5a6a72]">
              Bioacoustics{channelId ? " · shared library" : " · solo session"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          <OfflineStatusBadge />
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
          {!embedded && (
            <Link
              href="/workspace"
              className="border rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest whitespace-nowrap bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
            >
              Workspace
            </Link>
          )}
          <Link
            href="/profile"
            className="border rounded-lg px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest whitespace-nowrap bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
          >
            Profile
          </Link>
        </div>
      </div>

      {isMapMode && (
        <div className="absolute top-[68px] left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 px-2 w-full max-w-xs sm:w-auto sm:max-w-none">
          <form
            onSubmit={handleSpeciesSearch}
            className="pointer-events-auto flex gap-2 w-full sm:w-auto justify-center"
          >
            <input
              type="text"
              value={speciesQuery}
              onChange={(e) => handleSpeciesQueryChange(e.target.value)}
              placeholder="Scientific name…"
              className="bg-[#1c2226]/95 border border-[#3a444a] rounded-lg px-3 py-1 text-xs text-[#d3dbe0] placeholder:text-[#5a6a72] outline-none focus:border-[#8fa3ad] w-full sm:w-64 min-w-0"
            />
            <button
              type="submit"
              className="shrink-0 bg-[#1c2226]/95 border border-[#3a444a] rounded-lg px-3 py-1 text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-[#2a333a] hover:border-[#8fa3ad]/60"
            >
              Plot
            </button>
          </form>

          {speciesSearchStatus !== "idle" && (
            <div className="pointer-events-none bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest">
              {speciesSearchStatus === "loading" && (
                <span className="text-[#a48a55] flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#a48a55] animate-pulse" />
                  Searching…
                </span>
              )}
              {speciesSearchStatus === "success" && (
                <span className="text-[#8fa3ad]">
                  {speciesResultCount} sighting{speciesResultCount === 1 ? "" : "s"} found
                </span>
              )}
              {speciesSearchStatus === "empty" && (
                <span className="text-[#5a6a72]">No sightings found for this species</span>
              )}
              {speciesSearchStatus === "error" && (
                <span className="text-[#c47a6e]">Search failed — check connection and try again</span>
              )}
            </div>
          )}

          {monthsAvailable && (
            <div className="pointer-events-auto bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-1.5 w-full sm:w-64">
              <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-[#5a6a72] mb-1">
                <span>Seasonal occurrence</span>
                <span className="text-[#8fa3ad]">
                  {selectedMonth ? MONTH_NAMES[selectedMonth - 1] : "All months"}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="12"
                step="1"
                value={selectedMonth ?? 0}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  handleMonthFilterChange(v === 0 ? null : v);
                }}
                className="w-full h-1 accent-[#8fa3ad] cursor-pointer"
                aria-label="Filter sightings by month"
              />
              <p className="text-[8px] text-[#5a6a72] mt-1 leading-tight">
                Sighting records by month, pooled across years — not a tracked migration path.
              </p>
            </div>
          )}

          <button
            onClick={handleOpenHabitatTrend}
            className="pointer-events-auto bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest text-[#b7c4cc] hover:bg-[#2a333a] hover:border-[#8fa3ad]/60"
          >
            Habitat trend for this area
          </button>

          <button
            onClick={handleToggleVesselLayer}
            disabled={vesselStatus === "loading"}
            className={`pointer-events-auto border rounded-lg px-3 py-1 text-[10px] uppercase tracking-widest disabled:opacity-50 ${
              vesselLayerOn
                ? "bg-[#d8a877]/15 border-[#d8a877]/50 text-[#d8a877]"
                : "bg-[#1c2226]/90 border-[#3a444a] text-[#b7c4cc] hover:bg-[#2a333a] hover:border-[#8fa3ad]/60"
            }`}
          >
            {vesselStatus === "loading"
              ? "Loading vessel activity…"
              : vesselLayerOn
              ? "Hide vessel activity"
              : "Show vessel activity (90d)"}
          </button>
          {vesselStatus === "not_configured" && (
            <p className="pointer-events-none text-[9px] text-[#a48a55] text-center max-w-xs">
              Vessel tracking isn't configured — needs a Global Fishing Watch API key on the backend.
            </p>
          )}
          {vesselStatus === "error" && (
            <p className="pointer-events-none text-[9px] text-[#c47a6e] text-center max-w-xs">
              Vessel activity request failed — this integration is unverified against GFW's live
              API and may need adjustment.
            </p>
          )}
        </div>
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
          <p className={`text-[10px] uppercase tracking-widest ${telemetry.coordsSource === "live" ? "text-[#8fa3ad]" : "text-[#a48a55]"}`}>
            Coordinates · {telemetry.coordsSource === "live" ? "measured" : "simulated"}
          </p>
          <p className={`text-sm ${telemetry.coordsSource !== "live" ? "border-b border-dashed border-[#a48a55] inline-block" : ""}`}>
            {telemetry.coords}
          </p>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className={`text-[10px] uppercase tracking-widest ${diveLogSample?.temp_c !== undefined || telemetry.tempSource === "live" ? "text-[#8fa3ad]" : "text-[#a48a55]"}`}>
            Temp · {diveLogSample?.temp_c !== undefined ? "measured (dive log)" : telemetry.tempSource === "live" ? "measured" : "—"}
          </p>
          <p className="text-lg font-bold">
            {diveLogSample?.temp_c !== undefined ? `${diveLogSample.temp_c.toFixed(1)} °C` : telemetry.temp}
          </p>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className={`text-[10px] uppercase tracking-widest ${diveLogSample?.depth_m !== undefined || telemetry.depthSource === "live" ? "text-[#8fa3ad]" : "text-[#a48a55]"}`}>
            Depth · {diveLogSample?.depth_m !== undefined ? "measured (dive log)" : telemetry.depthSource === "live" ? "measured" : "simulated"}
          </p>
          <p className="text-lg font-bold">
            {diveLogSample?.depth_m !== undefined ? `${diveLogSample.depth_m.toFixed(1)} m` : telemetry.depth}
          </p>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className="text-[10px] uppercase tracking-widest text-[#a48a55]">Salinity · simulated</p>
          <p className="text-sm border-b border-dashed border-[#a48a55] inline-block">{telemetry.salinity}</p>
        </div>
        <div className="px-3 sm:px-4 py-2 sm:py-2.5">
          <p className={`text-[10px] uppercase tracking-widest ${operatorHeading !== null ? "text-[#7de88f]" : "text-[#a48a55]"}`}>
            Heading · {operatorHeading !== null ? "operator" : "simulated"}
          </p>
          <p className={`text-sm inline-block ${operatorHeading === null ? "border-b border-dashed border-[#a48a55]" : ""}`}>
            {operatorHeading !== null
              ? `${String(Math.round(operatorHeading)).padStart(3, "0")}°`
              : telemetry.heading}
          </p>
        </div>
        {isVideoMode && opticalFlow && opticalFlow.magnitude >= 0.05 && (
          <div className="px-3 sm:px-4 py-2 sm:py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-[#7de88f]">
              Motion · derived from feed
            </p>
            <p className="text-sm">
              {opticalFlow.heading_delta_deg}° drift · mag {opticalFlow.magnitude}
            </p>
          </div>
        )}
        {isVideoMode && coralBleachingRatio !== null && (
          <div className="px-3 sm:px-4 py-2 sm:py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-[#d8b877]">Coral · unvalidated model</p>
            <p className={`text-sm ${alert ? "text-[#d8b877]" : ""}`}>
              {(coralBleachingRatio * 100).toFixed(0)}% bleached
            </p>
          </div>
        )}
      </div>

      {isMapMode && (
        <div className="absolute bottom-4 left-4 flex gap-3 bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-2 pointer-events-none">
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
        <div className="pointer-events-auto bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-2">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">
            <label htmlFor="conf-threshold-slider">Confidence</label>
            <span className="text-[#d3dbe0] tabular-nums">{Math.round(confThreshold * 100)}%</span>
          </div>
          <input
            id="conf-threshold-slider"
            type="range"
            min="0.05"
            max="0.9"
            step="0.05"
            value={confThreshold}
            onChange={(e) => setConfThreshold(parseFloat(e.target.value))}
            className="w-full h-1 accent-[#8fa3ad] cursor-pointer"
            aria-label="Detection confidence threshold"
          />
        </div>
        <button
          onClick={handleDiscoverySnapshot}
          className="pointer-events-auto bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left text-[#b7c4cc] hover:bg-[#2a333a] hover:border-[#8fa3ad]/60"
        >
          Snapshot
        </button>
        <div className="pointer-events-auto bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-2">
          <div className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">
            Report scope
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setReportScope("mine")}
              className={`flex-1 rounded px-2 py-1 text-[10px] uppercase tracking-widest ${
                reportScope === "mine"
                  ? "bg-[#8fa3ad]/20 text-[#d3dbe0] border border-[#8fa3ad]/50"
                  : "text-[#8fa3ad] border border-transparent hover:text-[#b7c4cc]"
              }`}
            >
              Mine
            </button>
            <button
              onClick={() => setReportScope("team")}
              className={`flex-1 rounded px-2 py-1 text-[10px] uppercase tracking-widest ${
                reportScope === "team"
                  ? "bg-[#8fa3ad]/20 text-[#d3dbe0] border border-[#8fa3ad]/50"
                  : "text-[#8fa3ad] border border-transparent hover:text-[#b7c4cc]"
              }`}
            >
              Team
            </button>
          </div>
        </div>
        <button
          onClick={handleExportReport}
          disabled={exportingReport}
          className="pointer-events-auto bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left text-[#b7c4cc] hover:bg-[#2a333a] hover:border-[#8fa3ad]/60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {exportingReport && <span className="w-1.5 h-1.5 rounded-full bg-[#8fa3ad] animate-pulse" />}
          {exportingReport ? "Generating…" : "Export field report"}
        </button>
        <button
          onClick={handleEmailReport}
          disabled={emailingReport}
          className="pointer-events-auto bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left text-[#b7c4cc] hover:bg-[#2a333a] hover:border-[#8fa3ad]/60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {emailingReport && <span className="w-1.5 h-1.5 rounded-full bg-[#8fa3ad] animate-pulse" />}
          {emailingReport ? "Sending…" : "Email report"}
        </button>
        <button
          onClick={() => setFieldTranslatorOpen(true)}
          className="pointer-events-auto bg-[#1c2226]/90 border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left text-[#b7c4cc] hover:bg-[#2a333a] hover:border-[#8fa3ad]/60"
        >
          Field translator
        </button>
        {isVideoMode && (
          <button
            onClick={handleOpenLibrary}
            className="pointer-events-auto bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-left text-[#b7c4cc] hover:bg-white/[0.08]"
          >
            Clip library
          </button>
        )}
        {isVideoMode && (
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

      {isVideoMode && alert && (
        <div className="absolute bottom-28 sm:bottom-20 left-2 right-2 sm:left-auto sm:right-4 text-center sm:text-left bg-[#a48a55]/10 border border-[#b38d47] text-[#d8b877] rounded-xl px-3 sm:px-4 py-2 text-[11px] sm:text-xs">
          Possible bleaching — unverified
        </div>
      )}

      {isVideoMode && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 sm:w-16 sm:h-16 border border-[#8fa3ad]/60 rounded-full animate-pulse pointer-events-none" />
      )}

      {isVideoMode && (
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
            <input
              ref={diveLogInputRef}
              type="file"
              accept=".uddf,.xml"
              className="hidden"
              onChange={handleDiveLogSelected}
            />
            <button
              onClick={() => diveLogInputRef.current?.click()}
              className="border rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 text-[9px] sm:text-[10px] uppercase tracking-widest whitespace-nowrap bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
            >
              Attach dive log
            </button>
            {diveLogId && (
              <span className="text-[9px] text-[#7de88f]">
                Dive log attached — {diveLogSampleCount} real samples
              </span>
            )}
            {videoGpsInfo && (
              <span className="text-[9px] text-[#7de88f]">
                {videoGpsInfo}
              </span>
            )}
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

      {fieldTranslatorOpen && (
        <div className="absolute inset-0 bg-black/70 pointer-events-auto flex items-center justify-center p-3 sm:p-0">
          <FieldTranslator onClose={() => setFieldTranslatorOpen(false)} />
        </div>
      )}

      {habitatTrendCenter && (
        <div className="absolute inset-0 bg-black/70 pointer-events-auto flex items-center justify-center p-3 sm:p-0">
          <HabitatTrendPanel
            latitude={habitatTrendCenter.latitude}
            longitude={habitatTrendCenter.longitude}
            currentEmail={session?.user?.email}
            onClose={() => setHabitatTrendCenter(null)}
          />
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