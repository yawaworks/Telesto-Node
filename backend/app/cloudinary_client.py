import os

import cloudinary
import cloudinary.uploader

cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET"),
    secure=True,
)


def upload_snapshot(file_bytes: bytes, filename: str = "snapshot.jpg") -> dict:
    """Uploads a Discovery Snapshot image to Cloudinary under a dedicated
    folder, and returns the bits the frontend/DB actually need (not the
    full raw Cloudinary response)."""
    result = cloudinary.uploader.upload(
        file_bytes,
        folder="telesto-node/snapshots",
        resource_type="image",
        filename=filename,
        use_filename=True,
        unique_filename=True,
        overwrite=False,
    )
    return {
        "url": result.get("secure_url"),
        "public_id": result.get("public_id"),
        "width": result.get("width"),
        "height": result.get("height"),
        "bytes": result.get("bytes"),
        "created_at": result.get("created_at"),
    }


def upload_clip(file_bytes: bytes, filename: str = "clip.mp4") -> dict:
    """Uploads a full ROV video clip to Cloudinary (personal or shared
    library), separately from snapshots so the two are easy to manage/
    clean up independently in the Cloudinary media library later."""
    result = cloudinary.uploader.upload(
        file_bytes,
        folder="telesto-node/clips",
        resource_type="video",
        filename=filename,
        use_filename=True,
        unique_filename=True,
        overwrite=False,
    )
    return {
        "url": result.get("secure_url"),
        "public_id": result.get("public_id"),
        "duration": result.get("duration"),
        "bytes": result.get("bytes"),
        "created_at": result.get("created_at"),
    }


def delete_clip(public_id: str) -> bool:
    """Permanently removes a clip from Cloudinary storage (not just from
    the app's list of it). Returns True if Cloudinary confirms deletion."""
    result = cloudinary.uploader.destroy(public_id, resource_type="video")
    return result.get("result") == "ok"