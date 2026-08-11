import React, { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getJob, clipDownloadUrl } from "../api/client.js";
import ClipCard from "../components/ClipCard.jsx";

// Spacing auto-triggered downloads out instead of firing them all in the
// same tick - browsers (Chrome in particular) treat a burst of
// simultaneous programmatic downloads as spammy and silently block
// everything past the first few, which would make "auto-download" work
// for only 2-3 of a 15-clip job with no visible error.
const AUTO_DOWNLOAD_STAGGER_MS = 700;

const STAGES = ["queued", "downloading", "transcribing", "analyzing", "clipping", "completed"];

function formatElapsedTime(startedAt) {
  const started = new Date(startedAt);
  const seconds = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export default function JobStatus() {
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [clips, setClips] = useState([]);
  const [error, setError] = useState("");
  const [autoDownloading, setAutoDownloading] = useState(false);
  const hasAutoDownloadedRef = useRef(false);

  // Once the job finishes, automatically download every rendered clip
  // instead of waiting for the user to click each "Download clip" button
  // one at a time. Runs once per job (guarded by the ref, since `clips`
  // updates on every poll tick while the job is still completing).
  useEffect(() => {
    if (job?.status !== "completed") return;
    if (hasAutoDownloadedRef.current) return;
    const renderedClips = clips.filter((clip) => clip.status === "rendered");
    if (!renderedClips.length) return;

    hasAutoDownloadedRef.current = true;
    setAutoDownloading(true);

    const timers = renderedClips.map((clip, i) =>
      setTimeout(() => {
        const link = document.createElement("a");
        link.href = clipDownloadUrl(job._id, clip._id);
        link.download = "";
        document.body.appendChild(link);
        link.click();
        link.remove();
        if (i === renderedClips.length - 1) setAutoDownloading(false);
      }, i * AUTO_DOWNLOAD_STAGGER_MS)
    );

    return () => timers.forEach(clearTimeout);
  }, [job?.status, job?._id, clips]);

  useEffect(() => {
    let active = true;
    let interval;
    let failureCount = 0;

    // A Render free-tier backend that's spinning back up after a restart
    // (OOM, redeploy, cold start) takes 30-90s to answer again - see
    // client.js's SESSION_RETRY_DELAY_MS comment for the same situation on
    // the upload path. The old 5-failures-at-3s-each cutoff (15s) gave up
    // and showed "Cannot reach the API" well before the server came back,
    // even though the job itself was still running fine server-side.
    // 40 failures at 3s comfortably covers that window without leaving a
    // truly dead backend polling forever.
    const MAX_POLL_FAILURES = 40;
    // Don't flash the scary error banner on the first transient blip - only
    // surface it once a few in a row confirm this isn't just one dropped
    // request.
    const ERROR_DISPLAY_THRESHOLD = 3;

    async function poll() {
      try {
        const data = await getJob(jobId);
        if (!active) return;
        setJob(data.job);
        setClips(data.clips);
        setError("");
        failureCount = 0;
        if (["completed", "failed"].includes(data.job.status)) {
          clearInterval(interval);
        }
      } catch (err) {
        console.error("[JobStatus] poll failed:", err);
        if (!active) return;
        failureCount += 1;

        // A 404 means this job genuinely doesn't exist - no amount of
        // retrying fixes that, so stop immediately instead of burning the
        // full retry window on it.
        if (err.response?.status === 404) {
          setError(err.response?.data?.error || "Job not found.");
          clearInterval(interval);
          return;
        }

        if (failureCount >= ERROR_DISPLAY_THRESHOLD) {
          setError(err.response?.data?.error || err.message || "Failed to load job status.");
        }
        if (failureCount >= MAX_POLL_FAILURES) {
          clearInterval(interval);
        }
      }
    }

    poll();
    interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [jobId]);

  if (!job)
    return (
      <div className="page">
        {error ? <p className="error">{error}</p> : "Loading…"}
      </div>
    );

  const stageIndex = STAGES.indexOf(job.status);
  const renderedCount = clips.filter((clip) => clip.status === "rendered").length;
  const totalClips = job.clipRenderCount || clips.length;

  return (
    <div className="page">
      <Link to="/" className="back">
        &larr; New video
      </Link>

      <header className={`hero small ${job.status === "completed" ? "just-wrapped" : ""}`}>
        <span className="eyebrow">Job {job._id.slice(-6)}</span>
        <h1>
          {job.status === "completed"
            ? `${clips.length} clips ready`
            : job.status === "failed"
            ? "Something went wrong"
            : "Finding the best moments…"}
        </h1>
      </header>

      {job.status === "completed" && autoDownloading && (
        <p className="sub timing">Downloading your clips automatically&hellip;</p>
      )}

      {error && <p className="error">{error}</p>}

      {job.status === "failed" ? (
        <p className="error">{job.error}</p>
      ) : (
        <>
          {job.status !== "completed" && (
            <div className="filmstrip">
              <div className="filmstrip-holes" aria-hidden="true" />
              <div className="filmstrip-frames">
                {STAGES.slice(0, -1).map((stage, i) => (
                  <div
                    key={stage}
                    className={`frame ${i < stageIndex ? "done" : ""} ${i === stageIndex ? "active" : ""}`}
                  >
                    <span className="frame-num">{String(i + 1).padStart(2, "0")}</span>
                    <span className="frame-label">{stage}</span>
                  </div>
                ))}
              </div>
              <div className="filmstrip-holes" aria-hidden="true" />
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${job.progress}%` }} />
              </div>
            </div>
          )}

          {job.startedAt && job.status !== "queued" && (
            <p className="sub timing">Started {formatElapsedTime(job.startedAt)} ago.</p>
          )}

          {job.status === "clipping" && (
            <>
              {totalClips > 0 ? (
                <p className="sub">Rendering clips in the background — {renderedCount}/{totalClips} ready so far.</p>
              ) : job.clipRenderCount ? (
                <p className="sub">Preparing to render {job.clipRenderCount} clips — this may take a few minutes.</p>
              ) : (
                <p className="sub">Preparing clips for rendering — this may take a few minutes.</p>
              )}
            </>
          )}
        </>
      )}

      {clips.length > 0 && (
        <div className="clip-grid">
          {clips.map((clip, i) => (
            <ClipCard key={clip._id} jobId={job._id} clip={clip} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
