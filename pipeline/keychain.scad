// KeyForge parametric framed-name keychain.
// A dynamically sized rounded frame provides top, bottom, left, and right rails.
// Every A-Z/0-9 glyph overlaps the top and bottom rails, keeping the part connected.
// CLI: openscad -o out.stl -D name="ASHIM" keychain.scad

name = "MARA";
font = "Arial Black";

$fn = 64;

// ---- printable dimensions (millimetres) ----
letter_size = 14;
part_height = 5;
letter_spacing = 1.0;

rail_width = 1.8;
side_margin = 2.2;
corner_radius = 3.0;

// In OpenSCAD, text(size=...) maps this font's cap height to the requested size.
// Placing the rails across the baseline and cap line makes every supported glyph
// physically overlap both rails instead of merely appearing to touch them.
cap_height = letter_size;
frame_bottom = -rail_width * 0.58;
frame_top = cap_height + rail_width * 0.58;
frame_height = frame_top - frame_bottom;

hole_d = 5;
ring_wall = 2.0;
ring_od = hole_d + 2 * ring_wall;
ring_overlap = 1.0;

// Advance widths from the Arial Black font, expressed in em units. OpenSCAD
// 2021 has no text-metrics function, so this keeps the frame fitted to the name.
// Arial Black's cap height is 71.6% of its em square; OpenSCAD's requested text
// size maps to that cap height, hence the conversion below.
cap_to_em = 0.716;
supported = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
advances = [
  0.7778, 0.7778, 0.7778, 0.7778, 0.7222, 0.6670, 0.8330,
  0.8330, 0.3892, 0.6670, 0.8330, 0.6670, 0.9438, 0.8330,
  0.8330, 0.7222, 0.8330, 0.7778, 0.7222, 0.7222, 0.8330,
  0.7778, 1.0000, 0.7778, 0.7778, 0.7222,
  0.6670, 0.6670, 0.6670, 0.6670, 0.6670,
  0.6670, 0.6670, 0.6670, 0.6670, 0.6670
];

function glyph_advance(character) =
  let(matches = search(character, supported))
  len(matches) > 0 ? advances[matches[0]] : 0.8;

function name_advance(value, index = 0) =
  index >= len(value)
    ? 0
    : glyph_advance(value[index]) + name_advance(value, index + 1);

// OpenSCAD applies spacing to glyph placement. A small tolerance covers the
// font's right side-bearing and prevents the final letter touching the wall.
text_width = letter_size * letter_spacing * name_advance(name) / cap_to_em + 0.35;
frame_left = -side_margin;
frame_right = text_width + side_margin;
frame_width = frame_right - frame_left;
ring_center = [frame_left - ring_od / 2 + ring_overlap, frame_bottom + frame_height / 2];

module keychain_text() {
  text(
    name,
    size = letter_size,
    font = font,
    halign = "left",
    valign = "baseline",
    spacing = letter_spacing
  );
}

module rounded_rectangle(width, height, radius) {
  hull() {
    for (x = [radius, width - radius])
      for (y = [radius, height - radius])
        translate([x, y]) circle(r = radius);
  }
}

module frame_outline() {
  translate([frame_left, frame_bottom])
    difference() {
      rounded_rectangle(frame_width, frame_height, corner_radius);
      translate([rail_width, rail_width])
        rounded_rectangle(
          frame_width - 2 * rail_width,
          frame_height - 2 * rail_width,
          max(0.01, corner_radius - rail_width)
        );
    }
}

module solid_2d() {
  union() {
    keychain_text();
    frame_outline();
    translate(ring_center) circle(d = ring_od);
  }
}

module framed_name_keychain() {
  difference() {
    linear_extrude(part_height) solid_2d();
    translate([ring_center.x, ring_center.y, -1])
      cylinder(d = hole_d, h = part_height + 2);
  }
}

// color() affects previews only; STL and G-code keep the printer's filament color.
color([0.96, 0.79, 0.12]) framed_name_keychain();
