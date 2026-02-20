# Framework Control

A Windows desktop application for managing Framework laptop power, fan, and battery settings.

## Features

- **Real-time Monitoring**: CPU temperature, load, memory, battery status
- **TDP Control**: Adjust power limits using RyzenAdj
- **Fan Profiles**: Silent, Balanced, Performance modes
- **Battery Charge Limit**: Protect battery health by limiting charge
- **System Tray**: Minimize to tray, runs in background

## Development

```bash
# Install dependencies
npm install

# Run as web app (development)
npm run dev
# Then open http://localhost:3838

# Run as Electron app (development)
npm run electron:dev
```

## Build Windows Executable

```bash
# Install dependencies (including devDependencies)
npm install

# Build installer (.exe)
npm run electron:build

# Build portable version (single .exe, no install)
npm run electron:build:portable
```

The built files will be in the `dist/` folder:
- `Framework Control Setup 1.0.0.exe` - Installer
- `Framework Control 1.0.0.exe` - Portable version

## Requirements

- Windows 10/11
- For TDP control: [RyzenAdj](https://github.com/FlyGoat/RyzenAdj) (for AMD CPUs)
- For full features: Framework Laptop (EC access for fan/battery control)

## Distribution

To distribute the app:

1. Build the executable:
   ```bash
   npm run electron:build
   ```

2. The `dist/` folder contains:
   - Windows installer
   - Portable executable

3. Users just download and run - no Node.js required

## Architecture

```
┌─────────────────────────────────────────┐
│           Electron App                   │
├─────────────────────────────────────────┤
│  ┌─────────────┐    ┌────────────────┐  │
│  │  Frontend   │◄──►│  Backend       │  │
│  │  (Browser)  │    │  (Express+WS)  │  │
│  └─────────────┘    └───────┬────────┘  │
│                             │           │
│                     ┌───────▼────────┐  │
│                     │  Hardware API  │  │
│                     │  - RyzenAdj    │  │
│                     │  - WMI         │  │
│                     │  - EC Access   │  │
│                     └────────────────┘  │
└─────────────────────────────────────────┘
```

## License

MIT
# framework_manage_app
