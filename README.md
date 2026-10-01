# tracking

A web application for testing computer vision techniques on the web. This version is a
desktop top-down **snack beat machine**: QR codes on the table switch loops on and off.

## How to play

1. Serve the folder (`python3 -m http.server 8000`) and open `http://localhost:8000`.
   The camera and the sounds need `http://localhost` or HTTPS, not `file://`.
2. Tap **Tap to start** (this creates the audio and opens the camera), then point the camera at the table.
3. Put codes from the 2x3 code sheet on the table:
   `phone` = **Water**, `object-a` = **Candy**, `object-b` = **Cookie**.
   `bottle`, `object-c` and `notebook` are unused: they only get a box, no label and no sound.
4. A code that appears starts at the next bar and fades in. Take it away (not seen for 400 ms) and it fades out.
   Water shows blue ripples, Candy coloured dots, Cookie brown squares jumping every two beats.
5. Point at an item without touching it: top-right **By object** (Water, Candy, Cookie) or
   **By sound** (Gulp, Crackle, Crunch). The code is outlined in black and yellow, and By sound also shows a one-line
   description. Click again to cancel. If the item is not on the table you get "Cookie is not on the table."

## Sounds

`sounds/source/` holds the original recordings; `python3 make_loops.py` cuts them into
`sounds/water.wav`, `candy.wav` and `cookie.wav` (120 BPM, 4 s, crossfaded loop seam).
`preview.html` (build with `python3 build_preview.py`) shows the UI without a camera.
