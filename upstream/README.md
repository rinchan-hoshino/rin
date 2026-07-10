# Upstream Mirrors

This directory stores tracked upstream mirrors that Rin imports from external projects.

Purpose:

- keep repository-owned docs and upstream snapshots separate
- make upstream provenance explicit
- allow deterministic refreshes with small sync scripts

Current mirrors:

- `pi/`: mirrored from `badlogic/pi-mono` `packages/coding-agent`
- `skill-creator/`: mirrored from `anthropics/skills` `skills/skill-creator`

Each mirror keeps its own `_upstream.json` with source and sync metadata.

Refresh commands:

```bash
npm run sync:upstreams
```

Per-mirror aliases:

```bash
npm run sync:pi-docs
npm run sync:skill-creator
```
