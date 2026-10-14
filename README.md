# WME Quick Road Importer – Slovenia 🇸🇮

A Tampermonkey userscript for Waze Map Editor that shows roads from the Slovenian infrastructure cadastre (GJI) that are missing in WME, and adds one as a segment when you click it. Built for unmapped forest roads.

## How it works

After installing, you get an **SL-ROAD** tab in the WME sidebar.

1. Zoom in to level 16 or more
2. Click **Load roads in view**
3. Pink lines are cadastre roads with no WME road along them
4. **Click a pink line** to create a segment with its geometry

The new segment is selected, two-way, with no street and no city. Forest roads are also marked unpaved. It is not connected to anything: split, join and set junctions yourself, then save.

Each click creates exactly one segment from exactly the line you clicked. There is no bulk import.

Lines turn grey and dashed once added. WME's undo removes the segment as usual.

## Road types

The road type comes from the cadastre category. Pick one in the **Road type** dropdown to override it for the next clicks. Hovering a line shows its category, the road type a click would use, and its length.

| Category | Road type |
| --- | --- |
| avtocesta | Freeway |
| hitra cesta | Minor Highway |
| glavna cesta I./II. reda | Primary Street |
| regionalna cesta I./II./III. reda, turistična cesta | Primary Street |
| glavna mestna cesta, zbirna mestna ali krajevna cesta | Primary Street |
| lokalna cesta, javna pot, mestna ali krajevna cesta | Street |
| gozdna cesta | Off-road / Not maintained, unpaved |
| nekategorizirana cesta | Private Road |
| ni podatka | Street |

Cycle paths, hiking trails and footpaths are never shown.

## What counts as missing

A cadastre line is hidden when at least 80% of it lies within 15 m of a road WME has loaded. A road that only crosses it doesn't hide it. This only sees what WME has loaded, which is why loading needs zoom 16. When WME loads more map data, the check runs again.

## Options

- Show layer (on by default)
- Road type override (resets to Auto on reload)

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+R` | Load roads in view |
| `Alt+Shift+X` | Clear |

You can reassign them in WME's keyboard shortcuts dialog.

## Data

[eProstor](https://ipi.eprostor.gov.si) OGC API, layer `SI.GURS.KGI:LINIJE_CESTE_G`. Requests that time out or fail are retried twice before the load settles for what it has.

## Development

```bash
node --test
```

No dependencies and no build step. The pure logic is unit tested, and a harness boots the whole script against stubbed browser and SDK globals to drive load and click end to end. Rendering on the real map, and whether a new segment saves the way the harness assumes, still need a check in WME.
