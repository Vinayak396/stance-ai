# StanceAI UML Artifacts

This folder contains ready-to-use PlantUML diagram definitions for StanceAI:

- use-case.puml
- er-diagram.puml
- class-diagram.puml
- dfd.puml

## Recommended StarUML workflow

StarUML does not natively parse PlantUML text by default. Use one of these approaches:

1. Install a PlantUML extension/plugin for StarUML if available in your environment.
2. If plugin support is unavailable, generate PNG/SVG from `.puml` files using any PlantUML renderer and then trace/recreate in StarUML using these files as source-of-truth.

## Direct recreation checklist in StarUML

1. Create one model package per diagram type: Use Case, ERD, Class, DFD.
2. Recreate elements and connectors exactly from each `.puml` file.
3. Preserve names verbatim for traceability across diagrams.
4. Mark the backend stream path as optional in Class and DFD diagrams.
5. Export final diagrams to PNG/PDF.

## Scope assumptions represented

- Full repository architecture is modeled: Frontend + Supabase + FastAPI backend.
- Backend websocket analysis path is modeled as optional/alternate.
- ER contains both persisted entities and clearly marked conceptual entities.

## Source references used

- frontend/src/components/Dashboard.jsx
- frontend/src/hooks/usePoseDetection.js
- frontend/src/hooks/usePoseStream.js
- frontend/src/lib/biomechanics.js
- frontend/src/api/biomechanicsApi.js
- backend/main.py
- backend/pose_processor.py
- backend/biomechanics.py
- backend/models.py
- database/schema.sql
- database/rls_patch.sql
- database/import_benchmarks.js
