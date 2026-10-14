# WME Quick Road Importer – Slovenia 🇸🇮

A Tampermonkey userscript for Waze Map Editor that shows roads from the Slovenian infrastructure cadastre (GJI) that are missing in WME, and adds one as a segment when you click it. Built for unmapped forest roads.

## How it works

After installing, you get an **SL-ROAD** tab in the WME sidebar.

1. Zoom in to level 16 or more
2. Click **Load roads in view**
3. Pink lines are the parts of cadastre roads with no WME road along them
4. **Click a pink line** to create a segment with its geometry

The new segment is selected, two-way, with no street and no city. Forest roads are also marked unpaved. It is not connected to anything: split, join and set junctions yourself, then save.

Each click creates exactly one segment from exactly the pink line you clicked. There is no bulk import.

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

Only the parts of a cadastre road with no WME road running alongside them (within 15 m and roughly the same direction) are drawn. Where WME already has part of the road, the pink line starts where the cadastre turns away from it. A road that only meets or crosses a cadastre line doesn't count, so a short link between two roads shows whole and reaches both, and a line crossing a road is drawn across it for you to add the junction. Leftover bits shorter than 30 m are dropped, since those are usually the same road drawn slightly differently on a bend.

This only sees what WME has loaded, which is why loading needs zoom 16. When WME loads more map data, the check runs again.

## Snapping an existing road

To move an existing WME road onto the cadastre geometry, select one segment and click **Snap selected road to cadastre** (or press `Alt+Shift+G`). The new shape is drawn as a green dashed preview. Press again to apply it, or select something else to drop it.

The segment's two end nodes never move, so its connections stay as they are. Only the points in between are replaced with the cadastre's, bends included. It works across cadastre junctions and whichever way the cadastre is drawn. Where WME drew a bend far off, the cadastre's own shape fills the gap. Nothing is snapped if the cadastre runs alongside less than half of the segment, misses its first or last 15 m, or would jump between cadastre roads that don't meet. If the segment has house numbers, check them afterwards. WME's undo reverts a snap.

## Disconnected ends

A WME dead end within 5 m of another road it isn't connected to gets an orange ring. That's usually a junction someone meant to make and missed by a few metres, including the end of a road you just added. Connect it and the ring goes away. This only looks at WME data, so it works without loading anything. Ferries, railways and runways are ignored, since they don't connect to roads. The rings let clicks through, so you can drag the node right under one. The sidebar shows how many there are.

## Options

- Show layer (on by default)
- Show already mapped roads (off by default): draws every loaded cadastre road as a thin cyan line under the pink ones, so you can check WME geometry against it. Cyan lines can't be clicked.
- Show disconnected ends (on by default)
- Road type override (resets to Auto on reload)

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+R` | Load roads in view |
| `Alt+Shift+X` | Clear |
| `Alt+Shift+G` | Snap selected road to cadastre (press twice: preview, then apply) |

You can reassign them in WME's keyboard shortcuts dialog.

## Data

[eProstor](https://ipi.eprostor.gov.si) OGC API, layer `SI.GURS.KGI:LINIJE_CESTE_G`. Requests that time out or fail are retried twice before the load settles for what it has.

## Development

```bash
node --test
```

No dependencies and no build step. The pure logic is unit tested, and a harness boots the whole script against stubbed browser and SDK globals to drive load and click end to end. Rendering on the real map, and whether a new segment saves the way the harness assumes, still need a check in WME.
