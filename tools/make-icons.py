"""生成 Pixiv 打码助手扩展图标（粉紫渐变圆角方块 + 白色马赛克格）。

依赖：Pillow、numpy（见 tools/requirements.txt）
用法：
    python -m pip install -r tools/requirements.txt
    python tools/make-icons.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

S = 4  # 超采样倍数
BASE = 128
N = BASE * S
OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"


def gradient(size: int) -> Image.Image:
    y = np.linspace(0.0, 1.0, size)[:, None]
    x = np.linspace(0.0, 1.0, size)[None, :]
    t = np.clip(y * 0.82 + x * 0.18, 0.0, 1.0)
    c1 = np.array([255.0, 88.0, 162.0], dtype=np.float32)
    c2 = np.array([146.0, 76.0, 246.0], dtype=np.float32)
    arr = c1[None, None, :] * (1.0 - t[..., None]) + c2[None, None, :] * t[..., None]
    return Image.fromarray(arr.astype(np.uint8), "RGB").convert("RGBA")


def build() -> Image.Image:
    image = gradient(N)

    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, N - 1, N - 1], radius=int(30 * S), fill=255
    )
    image.putalpha(mask)

    draw = ImageDraw.Draw(image)
    tile = 16 * S
    gap = 4 * S
    pitch = tile + gap
    start = (N - (4 * pitch - gap)) // 2
    radius = 3 * S
    for row in range(4):
        for col in range(4):
            x0 = start + col * pitch
            y0 = start + row * pitch
            alpha = 240 if (row + col) % 2 == 0 else 215
            draw.rounded_rectangle(
                [x0, y0, x0 + tile, y0 + tile],
                radius=radius,
                fill=(255, 255, 255, alpha),
            )
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = build()
    for size in (16, 32, 48, 128):
        icon = big.resize((size, size), Image.LANCZOS)
        path = OUT / f"icon{size}.png"
        icon.save(path, optimize=True)
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
