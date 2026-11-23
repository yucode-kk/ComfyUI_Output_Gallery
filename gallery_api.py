"""Output Gallery backend: list, thumbnail, original image, move to trash."""

import asyncio
import hashlib
import os
from pathlib import Path

from aiohttp import web
from PIL import Image, ImageOps

import folder_paths
from server import PromptServer

try:
    from send2trash import send2trash
except ImportError:
    send2trash = None

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
THUMB_SIDE = 320
THUMB_QUALITY = 80
PAGE_MAX = 500
TRASH_MAX = 1000

routes = PromptServer.instance.routes
_thumb_slots = asyncio.Semaphore(4)
_dim_cache = {}
_resample = getattr(Image, "Resampling", Image).LANCZOS


def _output_root():
    return Path(folder_paths.get_output_directory()).resolve()


def _thumb_root():
    path = Path(folder_paths.get_temp_directory()) / "output_gallery_thumbs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _resolve(rel):
    """Map a relative path from the browser onto a file inside output/."""
    if not rel or rel.startswith(("/", "\\")) or ":" in rel:
        raise web.HTTPBadRequest(text="invalid path")
    root = _output_root()
    target = (root / rel.replace("\\", "/")).resolve()
    if target == root or not target.is_relative_to(root):
        raise web.HTTPBadRequest(text="invalid path")
    return target


def _scan():
    root = _output_root()
    items = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in IMAGE_EXTS:
                continue
            try:
                st = (Path(dirpath) / name).stat()
            except OSError:
                continue
            items.append({
                "id": name if rel_dir == "." else f"{rel_dir}/{name}",
                "name": name,
                "dir": "" if rel_dir == "." else rel_dir,
                "size": st.st_size,
                "modified": int(st.st_mtime),
            })
    return items


def _dimensions(rel, path, size, modified):
    key = (rel, size, modified)
    cached = _dim_cache.get(key)
    if cached:
        return cached
    try:
        with Image.open(path) as im:
            dims = im.size
    except Exception:
        dims = (0, 0)
    if len(_dim_cache) > 20000:
        _dim_cache.clear()
    _dim_cache[key] = dims
    return dims


def _thumb_name(rel, size, modified, side):
    digest = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
    return f"{digest}-{size}-{modified}-{side}"


def _make_thumb(src, dst, side):
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((side, side), _resample)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, (24, 24, 27))
            flat.paste(im, mask=im.split()[-1])
            im = flat
        elif im.mode != "RGB":
            im = im.convert("RGB")
        tmp = dst.with_name(dst.name + ".part")
        im.save(tmp, "WEBP", quality=THUMB_QUALITY, method=4)
    os.replace(tmp, dst)


def _drop_thumbs(rel):
    digest = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
    for thumb in _thumb_root().glob(f"{digest}-*.webp"):
        try:
            thumb.unlink()
        except OSError:
            pass


async def api_list(request):
    query = (request.query.get("q") or "").strip().lower()
    order = request.query.get("order", "desc")
    try:
        offset = max(0, int(request.query.get("offset", "0")))
    except ValueError:
        offset = 0
    try:
        limit = min(PAGE_MAX, max(1, int(request.query.get("limit", "100"))))
    except ValueError:
        limit = 100

    items = await asyncio.to_thread(_scan)
    if query:
        items = [item for item in items if query in item["id"].lower()]
    items.sort(key=lambda item: item["modified"], reverse=order != "asc")

    page = items[offset:offset + limit]
    root = _output_root()
    for item in page:
        width, height = await asyncio.to_thread(
            _dimensions, item["id"], root / item["id"], item["size"], item["modified"])
        item["width"] = width
        item["height"] = height

    return web.json_response({
        "items": page,
        "total": len(items),
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(page) < len(items),
    })


async def api_thumb(request):
    rel = request.query.get("path", "")
    try:
        side = min(1024, max(64, int(request.query.get("w", str(THUMB_SIDE)))))
    except ValueError:
        side = THUMB_SIDE

    src = _resolve(rel)
    if not src.is_file():
        raise web.HTTPNotFound()

    st = await asyncio.to_thread(src.stat)
    out = _thumb_root() / f"{_thumb_name(rel, st.st_size, int(st.st_mtime), side)}.webp"
    if not out.exists():
        async with _thumb_slots:
            if not out.exists():
                try:
                    await asyncio.to_thread(_make_thumb, src, out, side)
                except Exception as exc:
                    raise web.HTTPInternalServerError(text=f"thumbnail failed: {exc}")

    return web.FileResponse(out, headers={"Cache-Control": "public, max-age=604800"})


async def api_image(request):
    src = _resolve(request.query.get("path", ""))
    if not src.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(src, headers={"Cache-Control": "public, max-age=86400"})


async def api_trash(request):
    if send2trash is None:
        raise web.HTTPServiceUnavailable(text="send2trash is not installed")

    try:
        payload = await request.json()
    except Exception:
        raise web.HTTPBadRequest(text="invalid json")

    paths = payload.get("paths") if isinstance(payload, dict) else None
    if not isinstance(paths, list) or not paths:
        raise web.HTTPBadRequest(text="paths is required")
    if len(paths) > TRASH_MAX:
        raise web.HTTPBadRequest(text="too many paths")

    deleted = 0
    failed = []
    for rel in paths:
        if not isinstance(rel, str):
            failed.append({"path": str(rel), "error": "invalid path"})
            continue
        try:
            target = _resolve(rel)
        except web.HTTPException:
            failed.append({"path": rel, "error": "outside output or invalid"})
            continue
        if not target.is_file() or target.suffix.lower() not in IMAGE_EXTS:
            failed.append({"path": rel, "error": "not a gallery image"})
            continue
        try:
            await asyncio.to_thread(send2trash, str(target))
        except Exception as exc:
            failed.append({"path": rel, "error": str(exc)})
            continue
        _drop_thumbs(rel)
        deleted += 1

    return web.json_response({"deleted": deleted, "failed": failed})


routes.get("/output-gallery/list")(api_list)
routes.get("/output-gallery/thumb")(api_thumb)
routes.get("/output-gallery/image")(api_image)
routes.post("/output-gallery/trash")(api_trash)
