# WME Quick Road Importer – Slovenia 🇸🇮

A **Tampermonkey userscript** for Waze Map Editor (WME) that shows roads from the Slovenian infrastructure cadastre (GJI) that are missing in WME, and adds one as a segment when you click it.
It works for any road WME is missing, though most of them turn out to be forest roads hidden under the trees.

---

## 🧭 How It Works

After installing the script, you'll see a new **SL-ROAD** tab in the left sidebar of WME.

### Basic workflow
1. Zoom in to level 16 or more
2. Click **Load roads in view**
3. The script fetches the cadastre roads in view from eProstor and draws the parts WME doesn't have
4. **Click a pink line** to create a segment with its geometry

| Line | Meaning |
|------|---------|
| Pink | Part of a cadastre road with no WME road along it. Click it to add it |
| Grey dashed | A road you added since the last load |
| Cyan | Every loaded cadastre road, when **Show already mapped roads** is on |
| Green dashed | The preview of an aligned road (see [📐 Aligning an existing road](#-aligning-an-existing-road)) |
| Orange ring | A dead end next to a road it isn't connected to (see [🟠 Disconnected ends](#-disconnected-ends)) |

Hovering a pink line shows its category, the road type a click would use, and its length. The sidebar counts how many roads are missing, already mapped and added.

### 👉 Adding a road
**Each click creates exactly one segment from exactly the pink line you clicked.** There is no bulk import.

The new segment is selected, two-way, with no street and no city. Forest roads are also marked unpaved. It is not connected to anything: split, join and set junctions yourself, then save. WME's undo removes it as usual.

### 🛣️ Road types
The road type comes from the cadastre category. Pick one in the **Road type** dropdown to override it for the next clicks.

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

### 🔍 What counts as missing
Only the parts of a cadastre road with no WME road running alongside them (within 15 m and roughly the same direction) are drawn. Where WME already has part of the road, the pink line starts where the cadastre turns away from it.

A road that only meets or crosses a cadastre line doesn't count, so a short link between two roads shows whole and reaches both, and a line crossing a road is drawn across it for you to add the junction. Leftover bits shorter than 30 m are dropped, since those are usually the same road drawn slightly differently on a bend.

### ⚙️ Options
- Show layer (on by default)
- Show already mapped roads (off by default): the cyan lines, so you can check WME geometry against the cadastre. Cyan lines can't be clicked
- Show disconnected ends (on by default): turning it off also empties the list
- Road type override (resets to Auto on reload)

---

## 📐 Aligning an existing road

To move an existing WME road onto the cadastre geometry, select one segment and click **Align road geometry** (or press `Alt+Shift+G`). The new shape is drawn as a green dashed preview. Press again to apply it, or select something else to drop it.

The segment's two end nodes never move, so its connections stay as they are. Only the points in between are replaced with the cadastre's, bends included. It works across cadastre junctions and whichever way the cadastre is drawn. Where WME drew a bend far off, the cadastre's own shape fills the gap.

Nothing changes if the cadastre runs alongside less than half of the segment, misses its first or last 15 m, or would jump between cadastre roads that don't meet. If the segment has house numbers, check them afterwards. WME's undo reverts it.

---

## 🟠 Disconnected ends

A WME dead end within 5 m of another road it isn't connected to gets an orange ring. That's usually a junction someone meant to make and missed by a few metres, including the end of a road you just added. Connect it and the ring goes away.

This only looks at WME data, so it works without loading anything. Ferries, railways and runways are ignored, since they don't connect to roads. The rings let clicks through, so you can drag the node right under one. They show at every zoom, also with the layer hidden, and zoomed out below 16 they turn into solid orange dots so they're easier to spot.

The sidebar lists every end found this session by its coordinates. Click one and the map centres on it, at zoom 18 or closer. An end stays listed when you pan away, and drops off once WME shows it fixed. If you deleted the road instead, that happens the next time WME loads that spot at zoom 16+. A reload starts the list over.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+R` | Load roads in view |
| `Alt+Shift+X` | Clear |
| `Alt+Shift+G` | Align road geometry (press twice: preview, then apply) |

Shortcuts are registered via the WME SDK and appear in the WME keyboard shortcuts dialog. You can reassign them there.

---

## ⚠️ Notes & Gotchas

### 🔎 It only sees what WME has loaded
Whether a road is missing is worked out from the WME segments currently loaded, which is why loading needs zoom 16: zoomed out, WME leaves out the smaller roads and every one of them would show as missing. When WME loads more map data, the check runs again.

### ⏳ When eProstor is slow
Requests time out after 30 seconds. A page that times out, fails at the network level or comes back with a server error is re-issued up to twice, one second and then three seconds later, with a toast each time. A load spends at most four retries in total, so a bad day at eProstor can't turn one click into a very long wait.

If the retries run out, the roads that did arrive are still drawn and the sidebar says the load was partial. A request eProstor rejects is not retried; the message says so instead.

A view with more than 30,000 cadastre lines is cut off at that point. Zoom in and load again.

### 📡 Accuracy
The cadastre is official data, not ground truth. Check every road against the imagery before you add or align it.

---

## 🛠️ Installation

1. Install **Tampermonkey**  
   https://www.tampermonkey.net/

2. Install the script  
   https://raw.githubusercontent.com/zigapovhe/wme-sl-road-import/main/wme-sl-road-import.user.js

3. Reload Waze Map Editor
4. Open the **SL-ROAD** tab in the sidebar

---

## 🧪 Development

```bash
node --test
```

No dependencies and no build step: `node --test` is built into Node, and the userscript ships as a single file. The script exports its pure functions only when `module` exists, which never happens in Tampermonkey, and its WME entry point is skipped outside a browser.

The pure logic (categories, geometry, missing pieces, aligning, disconnected ends, the retry policy) is unit tested. A harness boots the whole script against stubbed browser and SDK globals and drives it end to end: loading, including timeouts, partial results and the page cap, clicking to add, aligning and the disconnected ends list. Another test checks that the SDK APIs the script checks for at startup are exactly the ones it calls.

The script is split into sections: page helpers, road types, geometry, missing pieces, disconnected ends, aligning, loading from eProstor, then the WME part, where each feature has its own setup function (`setupRoadLayer`, `setupLoading`, `setupAdding`, `setupAligning`, `setupDisconnectedEnds`). A new feature gets its own section of pure, exported logic with unit tests, and its own setup function with a harness test.

Rendering on the real map, and whether a new segment saves the way the harness assumes, still need a check in WME by hand.

---

## 🧩 Technical Info

- Uses the WME SDK (`getWmeSdk`) for the sidebar tab, map layers, segments, nodes, addresses, selection, events and keyboard shortcuts
- Calls the [eProstor](https://ipi.eprostor.gov.si) OGC API Features, layer `SI.GURS.KGI:LINIJE_CESTE_G`, using `GM_xmlhttpRequest`
- The data comes in WGS84 already, so nothing is reprojected. Distances are measured in a local flat projection, which is plenty for the few km a road spans
- Settings are kept in `localStorage`

---

## 👤 Author

Author: **ThatByte**  
Waze: https://www.waze.com/user/editor/ThatByte  
License: **MIT**
