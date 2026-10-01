# tracking

this is a web application for testing computer vision techniques on the web

## Snack beat box

Each QR code on the printed sheet stands for a snack. Put it in front of the camera and its sound joins in, take it away and the sound stops. Each sound is a full recording that loops, and the on-screen effect follows how loud it is.

| QR code | Snack | Sound |
| --- | --- | --- |
| `phone` | Water | Drinking water |
| `object-a` | Candy | Crunching amber candy |
| `object-b` | Cookie | Biting a cookie |

Tap "Tap to start" first so the browser allows sound. Pick a snack by its name or by its sound in the bottom-left buttons to highlight it on screen and read where the sound comes from.

The recordings are in `sounds/`. Serve the folder (for example `python3 -m http.server`) rather than opening `index.html` directly, or the sounds will not load.
