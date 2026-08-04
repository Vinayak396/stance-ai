# 🏏 StanceAI — Biomechanical Cricket Analyzer

> Real-time skeletal pose estimation and joint-angle biomechanics analysis for cricket batters — runs **entirely in the browser**, no server required.

[![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev)
[![MediaPipe](https://img.shields.io/badge/MediaPipe-WASM-orange)](https://ai.google.dev/edge/mediapipe)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres-3ecf8e?logo=supabase)](https://supabase.com)

---

## ✨ Features

- 🎥 **Live webcam** pose detection — real-time skeleton overlay at 15–30 fps
- 📁 **Video file upload** — analyze pre-recorded cricket footage frame-by-frame
- 📸 **Photo upload** — single-frame pose analysis from a still image
- 🔁 **Re-analyze** — change shot type and re-run analysis without re-uploading
- 📐 **33-landmark skeleton** rendered directly on a canvas overlay
- 🎯 **Joint angle classification** — Optimal / Warning / Critical vs. scientific benchmarks
- 📊 **Live metrics panel** — angle values, deviation bars, session stats
- ☁️ **Supabase backend** — benchmark storage, session logging, anomaly tracking

---

## 🏗️ Architecture

```
StanceAI/
├── frontend/          # React 19 + Vite — all UI and inference
│   └── src/
│       ├── components/
│       │   ├── Dashboard.jsx        # Main UI — controls, video, metrics panel
│       │   └── SkeletonOverlay.jsx  # Canvas renderer — 33 landmarks + angle labels
│       ├── hooks/
│       │   └── usePoseDetection.js  # MediaPipe WASM lifecycle — webcam, video, image
│       ├── lib/
│       │   ├── biomechanics.js      # Joint angle math + quality classification
│       │   └── supabaseClient.js    # Supabase JS client
│       └── api/
│           └── biomechanicsApi.js   # Supabase DB operations (benchmarks, sessions)
└── database/
    ├── schema.sql                   # Supabase (Postgres) DDL
    ├── rls_patch.sql                # Row-Level Security policies
    └── import_benchmarks.js        # Script to seed benchmark data
```

### How it works

```
Webcam / Video File / Photo
         │
         ▼
  React Dashboard (Vite)
         │
         ▼
  usePoseDetection Hook
         │  MediaPipe PoseLandmarker WASM
         │  (runs in-browser, GPU accelerated)
         │
         ▼
  33 Landmarks [x, y, z, visibility]
         │
         ├──▶ biomechanics.js  ──▶  Joint Angles + Quality Classification
         │                               │
         │                               ▼
         │                         Supabase (Postgres)
         │                         shot_benchmarks table
         │
         └──▶ SkeletonOverlay.jsx  ──▶  Canvas render (color-coded skeleton)
```

---

## ⚙️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, Vanilla CSS |
| Pose AI | MediaPipe PoseLandmarker (WASM + GPU delegate) |
| Biomechanics | Custom JS — dot-product vector angle math |
| Database | Supabase (Postgres) — benchmarks, sessions, anomalies |
| Fonts | Inter + JetBrains Mono (Google Fonts) |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- A free [Supabase](https://supabase.com) project

### 1. Clone & install

```bash
git clone https://github.com/your-username/StanceAI.git
cd StanceAI/frontend
npm install
```

### 2. Set up Supabase

Run the SQL files against your Supabase project (in order):

```
database/schema.sql       ← creates all tables
database/rls_patch.sql    ← applies Row-Level Security
```

Then seed the benchmark data:

```bash
cd database
node import_benchmarks.js
```

### 3. Configure environment

Create `frontend/.env`:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### 4. Run

```bash
cd frontend
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

> **Note:** The app works offline without Supabase — it falls back to hardcoded inline benchmarks sourced from published cricket biomechanics literature.

---

## 📐 Biomechanics Engine

### Joint angle calculation

The angle at any joint vertex **B** formed by points **A–B–C** is:

```
angle = arccos( (BA · BC) / (|BA| × |BC|) )
```

### Joints tracked (8 per frame)

| Joint | Landmarks |
|---|---|
| Front Elbow | L-Shoulder → L-Elbow → L-Wrist |
| Back Elbow | R-Shoulder → R-Elbow → R-Wrist |
| Front Knee | L-Hip → L-Knee → L-Ankle |
| Back Knee | R-Hip → R-Knee → R-Ankle |
| Front Hip | L-Shoulder → L-Hip → L-Knee |
| Back Hip | R-Shoulder → R-Hip → R-Knee |
| Left Shoulder | L-Elbow → L-Shoulder → L-Hip |
| Right Shoulder | R-Elbow → R-Shoulder → R-Hip |

### Quality classification

| Label | Meaning |
|---|---|
| 🟢 **OPTIMAL** | Angle within benchmark range |
| 🟡 **WARNING** | Deviation > warning tolerance |
| 🔴 **CRITICAL** | Deviation > critical tolerance |
| ⚪ **N/A** | No benchmark for this joint/shot |

### Benchmark sources

Benchmarks are based on peer-reviewed cricket biomechanics research:

- McErlain-Naylor & King (2020)
- ECB Level 3 Coaching Manual (2021)
- MCC Coaching Manual (2022)
- Cricket Australia Batting Guide (2023)
- Stretch et al. (2003)
- Ferdinands (2007, 2013)

---

## 🗄️ Database Schema

| Table | Purpose |
|---|---|
| `shot_benchmarks` | Optimal angle ranges per shot type and joint |
| `analysis_sessions` | Per-session metadata (shot type, input source, score) |
| `session_anomalies` | Per-frame anomaly records with deviation and severity |

### Supported shot types

Cover Drive · Pull Shot · Forward Defense · Sweep Shot · Cut Shot · Straight Drive · Hook Shot · On Drive · Lofted Drive · Flick Shot · Defensive Leave

---

## 🖥️ UI Overview

```
┌─────────────────────────────────────────────────────────┐
│  🏏 StanceAI  │ Shot Type ▾ │ Upload │ Re-analyze │ Webcam│  ● Live
├──────────────────────────────┬──────────────────────────┤
│                              │  JOINT ANGLES  COVER DRIVE│
│   VIDEO / IMAGE FEED         │  Front Elbow    ⚠ Warning │
│                              │  148.2°  ±8.2°            │
│   [skeleton overlay]         │  Front Knee     ✓ Optimal │
│                              │  146.5°                   │
│                              │  Back Hip       ✗ Critical│
│                              │  ...                      │
│                              ├──────────────────────────┤
│                              │  SESSION                  │
│                              │  355  4/8  14fps          │
└──────────────────────────────┴──────────────────────────┘
```

---

## 🔮 Roadmap

- [ ] Shot type auto-detection (ML classifier)
- [ ] Historical session analytics dashboard
- [ ] Side-by-side comparison with professional benchmarks
- [ ] Coach feedback report PDF export
- [ ] Mobile PWA support
