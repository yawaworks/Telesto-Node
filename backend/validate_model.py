"""
Model validation script for Telesto Node.

Compares the deployed /analyze-frame endpoint's output against a
human-labeled ground truth CSV, across a sweep of confidence thresholds,
and reports precision/recall/F1 per species class plus bleaching
classification accuracy — so confidence-threshold decisions and any
accuracy claims are backed by real numbers instead of assumption.

Usage:
    python validate_model.py \
        --images-dir path/to/test_frames \
        --ground-truth ground_truth.csv \
        --api-url https://telesto-node-backend.onrender.com

Ground truth CSV format (one row per frame) — see ground_truth_template.csv:
    filename,species_present,is_bleached
    frame001.jpg,"Acropora cervicornis;Chromis viridis",no
    frame002.jpg,"",yes
    frame003.jpg,"Chromis viridis",na

    - species_present: semicolon-separated list of species actually visible
      in the frame, using the SAME label strings your Roboflow model
      outputs (check exact casing/spelling against your model's class
      list in the Roboflow project). Leave empty if no target species are
      visible in the frame.
    - is_bleached: "yes" if visible coral is bleached, "no" if visible
      coral is healthy, "na" if no coral is visible in the frame to judge.
"""
import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

import requests

BLEACH_RATIO_THRESHOLD = 0.4  # matches BLEACHING_ALERT_THRESHOLD in the frontend
CONFIDENCE_SWEEP = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.70]


def load_ground_truth(path):
    rows = {}
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            species = {s.strip() for s in row["species_present"].split(";") if s.strip()}
            bleached = row["is_bleached"].strip().lower()
            rows[row["filename"]] = {"species": species, "bleached": bleached}
    return rows


def run_inference(images_dir, ground_truth, api_url):
    """Calls /analyze-frame once per image at a very low confidence
    threshold to capture ALL raw detections+scores, so every threshold in
    the sweep can be simulated locally afterward without re-hitting the
    API (and burning Roboflow quota) once per threshold per image."""
    results = {}
    for filename in ground_truth:
        image_path = Path(images_dir) / filename
        if not image_path.exists():
            print(f"  [skip] {filename} not found in {images_dir}")
            continue

        with open(image_path, "rb") as f:
            resp = requests.post(
                f"{api_url}/analyze-frame",
                params={"conf_threshold": 0.05},
                files={"file": (filename, f, "image/jpeg")},
                timeout=30,
            )
        if resp.status_code != 200:
            print(f"  [error] {filename}: HTTP {resp.status_code} — {resp.text[:200]}")
            continue

        results[filename] = resp.json()
        print(f"  [ok] {filename}: {len(results[filename].get('boxes', []))} raw detections")

    return results


def species_at_threshold(raw_result, threshold):
    return {
        b["label"] for b in raw_result.get("boxes", [])
        if b["confidence"] >= threshold
    }


def bleach_prediction_at_threshold(raw_result, threshold):
    """Mirrors the same logic /analyze-frame uses: prefer the dedicated
    coral_bleach classifier if it fired above threshold, else fall back to
    the CLAHE+HSV pixel-ratio heuristic."""
    classifications = raw_result.get("classifications", [])
    bleach_cls = next((c for c in classifications if c["source"] == "coral_bleach"), None)

    if bleach_cls and bleach_cls["confidence"] >= threshold:
        return "yes" if "bleach" in bleach_cls["label"].lower() else "no"

    ratio = raw_result.get("coral_bleaching_ratio")
    if ratio is None:
        return "na"
    return "yes" if ratio >= BLEACH_RATIO_THRESHOLD else "no"


def compute_species_metrics(ground_truth, inference_results, threshold):
    """Frame-level multi-label precision/recall/F1 per species class,
    treating each (frame, species) pair as one prediction instance. This
    is presence/absence validation, NOT bounding-box IoU matching — a
    reasonable first pass that doesn't require box-level ground truth,
    but a coarser standard than full detection mAP."""
    tp = defaultdict(int)
    fp = defaultdict(int)
    fn = defaultdict(int)

    for filename, gt in ground_truth.items():
        if filename not in inference_results:
            continue
        predicted = species_at_threshold(inference_results[filename], threshold)
        actual = gt["species"]

        for label in predicted | actual:
            if label in predicted and label in actual:
                tp[label] += 1
            elif label in predicted and label not in actual:
                fp[label] += 1
            elif label not in predicted and label in actual:
                fn[label] += 1

    per_class = {}
    all_labels = set(tp) | set(fp) | set(fn)
    for label in sorted(all_labels):
        p = tp[label] / (tp[label] + fp[label]) if (tp[label] + fp[label]) else 0.0
        r = tp[label] / (tp[label] + fn[label]) if (tp[label] + fn[label]) else 0.0
        f1 = 2 * p * r / (p + r) if (p + r) else 0.0
        per_class[label] = {
            "precision": round(p, 3), "recall": round(r, 3), "f1": round(f1, 3),
            "tp": tp[label], "fp": fp[label], "fn": fn[label],
        }

    total_tp, total_fp, total_fn = sum(tp.values()), sum(fp.values()), sum(fn.values())
    micro_p = total_tp / (total_tp + total_fp) if (total_tp + total_fp) else 0.0
    micro_r = total_tp / (total_tp + total_fn) if (total_tp + total_fn) else 0.0
    micro_f1 = 2 * micro_p * micro_r / (micro_p + micro_r) if (micro_p + micro_r) else 0.0

    return per_class, {"precision": round(micro_p, 3), "recall": round(micro_r, 3), "f1": round(micro_f1, 3)}


def compute_bleach_metrics(ground_truth, inference_results, threshold):
    tp = fp = fn = tn = 0
    for filename, gt in ground_truth.items():
        if filename not in inference_results or gt["bleached"] == "na":
            continue
        predicted = bleach_prediction_at_threshold(inference_results[filename], threshold)
        if predicted == "na":
            continue

        actual = gt["bleached"]
        if predicted == "yes" and actual == "yes":
            tp += 1
        elif predicted == "yes" and actual == "no":
            fp += 1
        elif predicted == "no" and actual == "yes":
            fn += 1
        elif predicted == "no" and actual == "no":
            tn += 1

    total = tp + fp + fn + tn
    accuracy = (tp + tn) / total if total else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    return {
        "accuracy": round(accuracy, 3), "precision": round(precision, 3),
        "recall": round(recall, 3), "f1": round(f1, 3),
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
    }


def main():
    parser = argparse.ArgumentParser(description="Validate Telesto Node's detection models against labeled ground truth.")
    parser.add_argument("--images-dir", required=True, help="Folder containing the test frame images")
    parser.add_argument("--ground-truth", required=True, help="Path to ground_truth.csv")
    parser.add_argument("--api-url", default="https://telesto-node-backend.onrender.com", help="Backend API base URL")
    parser.add_argument("--output", default="validation_report.json", help="Where to save the full report")
    args = parser.parse_args()

    print(f"Loading ground truth from {args.ground_truth}...")
    ground_truth = load_ground_truth(args.ground_truth)
    print(f"  {len(ground_truth)} labeled frames loaded.\n")

    print(f"Running inference against {args.api_url} (this may take a while on Render's free tier — the")
    print(f"backend may need ~50s to wake up if it's been idle)...")
    inference_results = run_inference(args.images_dir, ground_truth, args.api_url)
    print(f"\n  {len(inference_results)}/{len(ground_truth)} frames successfully processed.\n")

    if not inference_results:
        print("No frames were successfully processed — check --images-dir and --api-url, then try again.")
        return

    report = {"threshold_sweep": []}

    print(f"{'Threshold':>10} | {'Species P':>10} {'Species R':>10} {'Species F1':>11} | {'Bleach Acc':>10} {'Bleach F1':>10}")
    print("-" * 80)

    best_species_f1 = (-1, None)
    best_bleach_f1 = (-1, None)

    for threshold in CONFIDENCE_SWEEP:
        per_class, species_micro = compute_species_metrics(ground_truth, inference_results, threshold)
        bleach = compute_bleach_metrics(ground_truth, inference_results, threshold)

        print(f"{threshold:>10.2f} | {species_micro['precision']:>10.2f} {species_micro['recall']:>10.2f} "
              f"{species_micro['f1']:>11.2f} | {bleach['accuracy']:>10.2f} {bleach['f1']:>10.2f}")

        report["threshold_sweep"].append({
            "threshold": threshold,
            "species_per_class": per_class,
            "species_micro": species_micro,
            "bleach": bleach,
        })

        if species_micro["f1"] > best_species_f1[0]:
            best_species_f1 = (species_micro["f1"], threshold)
        if bleach["f1"] > best_bleach_f1[0]:
            best_bleach_f1 = (bleach["f1"], threshold)

    print("\n" + "=" * 80)
    print(f"Best species-detection F1: {best_species_f1[0]:.2f} at threshold {best_species_f1[1]}")
    print(f"Best bleaching-classification F1: {best_bleach_f1[0]:.2f} at threshold {best_bleach_f1[1]}")
    print("=" * 80)
    print("\nNOTE: this is frame-level presence/absence validation, not bounding-box")
    print("IoU-based detection mAP. It tells you whether the model correctly says a")
    print("species/bleaching IS or ISN'T present in a frame — a real and useful first")
    print("validation pass, but a coarser standard than full object-detection accuracy.")

    report["summary"] = {
        "n_frames_labeled": len(ground_truth),
        "n_frames_evaluated": len(inference_results),
        "best_species_threshold": best_species_f1[1],
        "best_species_f1": round(best_species_f1[0], 3),
        "best_bleach_threshold": best_bleach_f1[1],
        "best_bleach_f1": round(best_bleach_f1[0], 3),
    }

    with open(args.output, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nFull report saved to {args.output}")


if __name__ == "__main__":
    main()