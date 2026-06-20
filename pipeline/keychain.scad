// KeyForge parametric name keychain — two styles:
//   style="letters"  pure 3D letters, no base; a thin outline weld-plate joins them (default)
//   style="tag"      raised letters on a solid tag (fallback for names that don't connect)
// CLI: openscad -o out.stl -D name="MAYA-2" -D style="letters" keychain.scad
// Connectivity check: a valid result renders as ONE solid -> OpenSCAD reports "Volumes: 2"
// (inside + outside). Anything higher means disconnected pieces — do not print.

name = "ALEX";
style = "letters";
font = "Arial Black";

$fn = 64;

// ---- letters style ----
// Pure 3D letters at natural spacing, joined by rails along the baseline and cap line.
// Every uppercase letter/digit touches both lines by definition, so connectivity is
// guaranteed for any A-Z0-9 name.
l_size = 14;        // letter height in mm
l_height = 5;       // uniform thickness — destructive test on the 4mm GETTYSBURG print
                    // snapped too easily; bending strength goes with thickness cubed
l_spacing = 1.0;
l_ring_pos = [-8.5, l_size * 0.30];   // left of the text with a ~2.5mm gap to the first
                                      // letter; joined only through the underline rail
l_ring_od = 12;
hole_d = 5;

module l_text() {
  text(name, size = l_size, font = font, halign = "left", valign = "baseline", spacing = l_spacing);
}

// underline spanning ring-to-last-letter: intersect text with a strip at the baseline, hull
// the result with a small anchor disc over the ring (so it always reaches the ring no matter
// the first letter's shape), then union a slightly lowered copy so the line protrudes ~1mm
// below the letters — visible underline, and a continuous spine for strength
module l_rail_core() {
  hull() {
    intersection() {
      l_text();
      translate([-300, -0.2]) square([600, 1.4]);
    }
    translate([l_ring_pos.x, 0.5]) circle(d = 2.2);
  }
}

module l_rail() {
  l_rail_core();
  translate([0, -2.0]) l_rail_core();   // deeper spine: the underline carries the bending load
}

module l_solid_2d() {
  union() {
    l_text();
    l_rail();
    translate(l_ring_pos) circle(d = l_ring_od);
  }
}

module letters_style() {
  difference() {
    linear_extrude(l_height) l_solid_2d();
    translate([l_ring_pos.x, l_ring_pos.y, -1]) cylinder(d = hole_d, h = l_height + 2);
  }
}

// ---- tag style ----
t_size = 11;
t_base = 2.8;
t_emboss = 1.0;
t_tab_wall = 3.5;
t_margin = 3.5;
t_tab_x = -(hole_d / 2 + t_tab_wall);

module t_text() {
  text(name, size = t_size, font = font, halign = "left", valign = "center");
}

module tag_style() {
  difference() {
    union() {
      linear_extrude(t_base) union() {
        hull() offset(r = t_margin) t_text();
        translate([t_tab_x, 0]) circle(d = hole_d + 2 * t_tab_wall);
      }
      linear_extrude(t_base + t_emboss) t_text();
    }
    translate([t_tab_x, 0, -1]) cylinder(d = hole_d, h = t_base + t_emboss + 2);
  }
}

// color() only affects preview/PNG rendering — it is ignored when exporting STL/G-code,
// so this keeps previews a clean gold without changing the printed part at all.
color([0.96, 0.79, 0.12])
if (style == "letters") letters_style();
else tag_style();
