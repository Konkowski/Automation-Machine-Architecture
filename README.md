# AMA — Automation Machine Architecture

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Konkowski/AMA)](https://github.com/Konkowski/AMA/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)

**Build PLC software from reusable, deterministic blocks.**
AMA is a free desktop app (Electron + React + TypeScript) that follows the ISA-95, ISA-88 and PackML concepts: you keep a library of tested blocks, assemble machines from it, and export the result to **Studio 5000 (L5X)** and **TIA Portal (Openness package)**.

## Screenshots

*All screenshots use the invented demo machine in [`examples/tablet-press`](examples/tablet-press).*

**Assemble a machine from released blocks**
![Assembly tree and mind map of the demo tablet press](docs/screenshots/assembly-tree.png)

**Write code at every level of the ISA-88 model**
![Structured Text editor with a PackML-style state machine](docs/screenshots/code-base-editor.png)

**See where the DFMEA says the code base needs attention**
![Risk page ranking blocks by RPN](docs/screenshots/risk-dfmea.png)

**Machine topology with IEC 62443 security zones**
![Network topology with a connection configuration panel](docs/screenshots/network-topology.png)

**Bill of materials built from the blocks you assemble**
![SBOM table with parts derived from the code base](docs/screenshots/sbom.png)

## Download

1. Go to the [**latest release**](https://github.com/Konkowski/AMA/releases/latest).
2. Download `AMA-vX.Y.Z-windows-x64.zip` and extract it.
3. Run `Automation Machine Architecture.exe`.

Windows 64-bit only for now. Because the app is not code-signed yet, Windows may show *"Windows protected your PC"*: click **More info → Run anyway**.

## What it does

AMA has two workspaces:

- **Code base** (for the Product Owner). The reusable ISA-88 library: Unit, Equipment Module, Control Module and Function Block, with code, alarms, I/O, components and DFMEA. It lives in a Git repository that you point to. A block can only be *Released* after it passes the release checks, and the DFMEA shows where blocks and components need attention.
- **Machine** (for the assembler). Assemble a machine from the code base, adjust it for the customer (instances, parameters, SBOM, network topology), verify it, and export to Studio 5000 (L5X) and TIA Portal, plus the documents.

It can also **import existing PLC projects** into a machine:

- **Studio 5000**: an `.L5X` file.
- **TIA Portal**: pick the project file and AMA reads it through TIA Openness (read-only): blocks, PLC tags, data types, I/O, alarms and hardware. LAD/FBD networks are converted to Structured Text so the logic stays readable. Needs TIA Portal with the Openness option and the .NET SDK on the PC. The extractor is in [`tools/tia-extractor`](tools/tia-extractor) and can also be run on its own.

The workflow is four steps: **Machine → Assembly → Analysis → Verify and export**.

## Your data stays on your computer

AMA has no server and no telemetry. Your work is saved locally in your Windows user profile (`%APPDATA%\automation-machine-architecture`) and in the files you choose to save. The demo machine shipped in the app (`lib/defaults.ts`) is invented and contains no real machine data.

If you use AMA with confidential code, keep your machine files and your code base in a **separate, private** repository, never inside a clone of this project.

## Run from source

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm run dev             # web UI at http://localhost:3000
npm run electron:start  # desktop app (loads the built UI from dist/)
```

Useful commands:

```bash
npm run typecheck      # TypeScript check
npm test               # run the tests
npm run build          # typecheck + production build
npm run electron:pack  # package the Windows app
```

## Project layout

| Folder | What |
|---|---|
| `pages/`, `components/` | UI (ribbon, workspaces, editors) |
| `lib/` | store, exporters/importers, release checks, DFMEA guidance |
| `electron/` | main process and preload bridge |
| `tests/` | tests (`npm test`) |

## Contributing

Contributions are welcome: bug reports, ideas, documentation and code. See [CONTRIBUTING.md](CONTRIBUTING.md). New to GitHub? Opening an [issue](https://github.com/Konkowski/AMA/issues/new/choose) is the easiest way to start.

## License

[MIT](LICENSE). Free to use, modify and share, including at work.

*Studio 5000 and Rockwell Automation are trademarks of Rockwell Automation, Inc. TIA Portal and Siemens are trademarks of Siemens AG. AMA is an independent project and is not affiliated with or endorsed by them.*
