#!/usr/bin/env python3
"""
Simple script to create a basic icon for Claude Manager.
Requires Pillow: pip install Pillow
"""

try:
    from PIL import Image, ImageDraw, ImageFont
    import os
except ImportError:
    print("ERROR: Pillow not installed. Run: pip install Pillow")
    exit(1)

# Icon sizes to generate
SIZES = [16, 32, 48, 64, 128, 256]

# Create a 256x256 base image
size = 256
img = Image.new('RGBA', (size, size), color=(37, 99, 235, 255))  # Blue background

# Draw a simple "CM" text
draw = ImageDraw.Draw(img)

# Try to use a system font, fallback to default
try:
    font = ImageFont.truetype("segoeui.ttf", 140)
except:
    try:
        font = ImageFont.truetype("arial.ttf", 140)
    except:
        font = ImageFont.load_default()

# Draw "CM" in white
text = "CM"
# Get text bounding box for centering
bbox = draw.textbbox((0, 0), text, font=font)
text_width = bbox[2] - bbox[0]
text_height = bbox[3] - bbox[1]

x = (size - text_width) // 2
y = (size - text_height) // 2 - 10

draw.text((x, y), text, fill=(255, 255, 255, 255), font=font)

# Save as PNG first
png_path = os.path.join(os.path.dirname(__file__), 'icon.png')
img.save(png_path, 'PNG')
print(f"Created: {png_path}")

# Create ICO with multiple sizes
ico_path = os.path.join(os.path.dirname(__file__), 'icon.ico')
icon_sizes = [(s, s) for s in SIZES]

# Generate images at different sizes
icons = []
for icon_size in icon_sizes:
    resized = img.resize(icon_size, Image.Resampling.LANCZOS)
    icons.append(resized)

# Save as ICO
icons[0].save(ico_path, format='ICO', sizes=icon_sizes, append_images=icons[1:])
print(f"Created: {ico_path}")
print("\nIcon created successfully!")
print("The app will now have a blue background with white 'CM' letters.")
