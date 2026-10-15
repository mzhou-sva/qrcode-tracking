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
4. A code that appears starts at the next bar and fades in. Take it away (not seen for 400 ms, or three recent frame intervals if that is longer) and it fades out.
   Water shows blue ripples, Candy coloured dots, Cookie brown squares jumping every two beats.
5. Point at an item without touching it: top-right **By object** (Water, Candy, Cookie) or
   **By sound** (Gulp, Crackle, Crunch). The code is outlined in black and yellow, and By sound also shows a one-line
   description. Click again to cancel. If the item is not on the table you get "Cookie is not on the table."
6. Ask by place: the **Where** grid (3x3, same layout as the picture grid, hover for the zone name). Click a cell and that part
   of the picture is filled with translucent yellow; the info line gives the zone, its range and what is in it, e.g.
   `Upper right (x 67–100%, y 0–33%): Candy is here.`, `... : Water and Cookie are here.` or `... : empty.`
   Click the same cell again to clear it. Where, By object and By sound share one info line and one selection: choosing
   one clears the other two.
7. Describe a place in words: type into the **Describe** box (placeholder `e.g. top left, right side, middle`) and press Enter.
   Capitals and hyphens do not matter. `top`, `upper`, `up`, `above` mean up; `bottom`, `lower`, `down`, `below` mean down;
   `left`, `right`; `middle`, `center`, `centre` only fill in a direction that is still open. Small filler words
   (`the`, `of`, `side`, `area`, `corner`, `part`, `in`, `at`, `screen`, ...) are ignored. So `top left` is Upper left,
   `left middle` and `middle left` are Middle left, `top middle` is Upper middle, `middle` alone is Center, `left` alone is the
   whole Left column and `top` alone is the whole Top row. Add `row` or `column` to say it explicitly:
   `top row`, `middle row`, `bottom row` give a whole row and `left column`, `middle column`, `right column` a whole column
   (Top row, Middle row, Bottom row, Left column, Middle column, Right column); a row cannot take left or right and a column cannot take up or down.
   `left right` or `top bottom` is a conflict and, like any unknown word, gives `I did not understand 'xyz'. Try: left, upper right, bottom, center.`
   The region is filled with translucent yellow like Where, and the info line gives the zone name, the range, the centre point
   and where that point is on screen in pixels, then what is inside, e.g.
   `Left column: x 0–33%, y 0–100%, center point (17%, 50%), about 273 px, 360 px on screen. Cookie is here.`
   (an empty region ends with `Empty.`)
   Enter on an empty box cancels. The Describe box, Where, By object and By sound share one info line: submitting a description
   clears the other three, and choosing any of the other three clears the box.

## Controls panel and labels

- The **Controls** button at the top right collapses or expands the whole control panel. It starts collapsed when the window is
  narrower than 700 px and expanded otherwise (the default is re-applied when the window is resized, until you press the button).
  When the panel is taller than the room above the status pills it scrolls inside itself and never covers the pills.
- Labels are placed every frame in the fixed order Water, Candy, Cookie. A label that overlaps one already placed moves down until it
  just clears it (with a small gap), or up when there is no room below, and always stays inside the picture and above the status
  pills. The fixed order keeps labels from jumping about between frames.

## Camera

- It asks for 2560×1440 at 30 fps (ideal values, so a camera that cannot do that gives its closest mode). If the request fails it
  retries 1920×1080, 1280×720, 640×480 and then any camera. The picture used for recognition is still shrunk to 960 px wide.
- The first camera is the default one: names only appear once permission is granted. When the list arrives, a camera whose name
  contains `ugreen` (any case) is used instead. A remembered choice comes first, and if the remembered camera is not there any more
  the same rule applies (UGREEN if present, otherwise the default camera).
- With two or more cameras a **Camera** menu appears at the top of the control panel. The choice is kept in `localStorage`
  (key `snack-camera`, read and written inside try/catch; it stores the device id and the name, and when a browser hands out new ids
  for every session the name is used to find the same camera) and the list refreshes when a camera is plugged in or out; if the camera in
  use disappears it switches to the fallback above.
- When the camera supports it, focus, exposure and white balance are set to `continuous`; unsupported ones are skipped quietly.
- The console prints what was actually granted, e.g. `Camera "UGREEN Camera 2K": 2560x1440 @ 30fps`.
- Switching camera resets the measured code size so recognition measures again.
- How long a code may go unseen before it counts as taken away is the larger of 400 ms and three times the recent time between
  recognition updates (smoothed with factor 0.2, one sample capped at 2 s), so one missed frame on a slow device no longer stops it.

## Position system

The camera picture is shown whole (`object-fit: contain`, black bars at the sides) with a faint 3x3 grid on top.
Every item has two position expressions, shown in the second line of its label, e.g. `Middle left · x 20% y 50%`:

- **Zone name**: Upper left, Upper middle, Upper right, Middle left, Center, Middle right, Lower left, Lower middle, Lower right.
- **Coordinates**: the centre of the code's four corners as a percentage of the whole camera frame.
  The displayed numbers are smoothed (factor 0.3). The **Measure from** switch (top-right) picks the reference frame:
  - **Top-left corner** (default): origin top-left, x to the right, y downwards, 0 to 100%, e.g. `x 20% y 50%`.
  - **Center**: origin at the centre of the frame, x to the right is positive, y upwards is positive, whole numbers from
    -50 to +50, e.g. `x −30% y 0%`.

  The switch only changes the displayed numbers; zone names, the grid and `percentToScreen` stay the same. It is not remembered after a reload.
  Clicking By object or By sound also writes the position in the info line, e.g.
  `Cookie is in the middle left: x 20%, y 50% (from the top-left corner).`

The range in the Where answer follows **Measure from** too: `Upper right (x 67–100%, y 0–33%)` from the top-left corner,
`Upper right (x +17–+50%, y +17–+50%)` from the center. Which items are "in" a cell is decided with the same zone as the label
(only items currently in view; an item that was just taken away and is fading out does not count). The yellow fill is a layer between
the camera and the effects, placed with `percentToScreen`, so the black bars of `contain` are taken into account.

Percent coordinates convert to screen pixels with `percentToScreen(x, y, frame, viewport)` in `snacks.js`:
`fit = min(viewportW / frameW, viewportH / frameH)`, then `screenX = (viewportW - frameW * fit) / 2 + x / 100 * frameW * fit`
(same for y; it always takes the top-left percentages). In the browser console: `machine.positions({ width: innerWidth, height: innerHeight })`.

## Sound position

Each item's sound is panned left or right by where its code is in the picture. The pan comes from the smoothed horizontal
percentage measured from the top-left corner (whatever **Measure from** says): `pan = (x − 50) / 50 * 0.9`, so x 0% is −0.9,
x 50% is 0 and x 100% is +0.9. It goes through a `StereoPannerNode` in each item's chain and is updated with `setTargetAtTime`
(time constant 0.1 s). When a code first appears the pan is set straight to its position, and nothing is updated while the item is
out of view, so a fading-out sound keeps its last pan. While an item is playing its pill shows where the sound sits, e.g.
`Playing · L 60% · every 2 beats`, `Playing · Center · every beat` or `Playing · R 40% · every 4 beats` (the number is |x − 50| * 2;
45% to 55% counts as Center; the last part is the rhythm tier, see below).

## Rhythm by height

The loops are never cut. Each item's chain is source → **gate** → fade gain → panner → master, and the gate (its own `GainNode`,
separate from the fade) decides which beats can be heard. How often depends on the smoothed vertical percentage measured from
the top-left corner (whatever **Measure from** says):

- upper third (y < 33.3%): every beat (`every beat`)
- middle third: every 2 beats, on beats 1 and 3 of the bar (`every 2 beats`)
- lower third: once per bar, on beat 1 (`every 4 beats`)

At every beat that should sound the gate is scheduled ahead on the audio clock (3 s look-ahead): 0 → 1 in 10 ms, held 0.30 s,
back to 0 in 0.12 s, and 0 the rest of the time. The tier changes with a hysteresis: the code has to cross a boundary by 3
percentage points or more, and the change starts at the next beat, so the hit that is sounding is never cut. When an item is taken
away the fade-out runs as before and its upcoming gate events are cancelled; when it is put back, the gate starts again on the next
bar line. At each hit a ring in the item's colour grows from 0.5× to 1× of the code's size (diameter) and fades within 0.25 s; it is
drawn from the same scheduled hit times as the sound, above the effects and below the labels. The pills show the tier, e.g.
`Playing · L 60% · every 2 beats`, and By object ends with `It plays every 2 beats.`

## Sounds

`sounds/source/` holds the original recordings; `python3 make_loops.py` cuts them into
`sounds/water.wav`, `candy.wav` and `cookie.wav` (120 BPM, 4 s, crossfaded loop seam).
