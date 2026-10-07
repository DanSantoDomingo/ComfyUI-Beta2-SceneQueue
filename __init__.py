import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

import folder_paths
from imageio_ffmpeg import get_ffmpeg_exe
from nodes import SaveImage


class Beta2SceneQueue:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "scene_plan": ("STRING", {"default": '{\n  "run_name": "MyFilm",\n  "shared_prompt": "",\n  "scenes": []\n}', "multiline": True}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "configure"
    CATEGORY = "Beta2/Scenes"
    DESCRIPTION = "Use Run / Resume Scenes on this node. Keep this workflow open while it queues scenes. Reference names come from Load Image titles beginning with REF:."

    def configure(self, scene_plan):
        return ()


class Beta2SaveLastFrame:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "filename_prefix": ("STRING", {"default": "H3/Scenes/last_frame"}),
        }, "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Beta2/Scenes"

    def save(self, images, filename_prefix, prompt=None, extra_pnginfo=None):
        result = SaveImage().save_images(images[-1:].clone(), filename_prefix, prompt, extra_pnginfo)
        return {"ui": result["ui"], "result": ()}


def output_video(relative):
    root = Path(folder_paths.get_output_directory()).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or path.suffix.lower() != ".mp4":
        raise ValueError("Scene clips must be MP4 files inside the ComfyUI output folder.")
    if not path.is_file():
        raise FileNotFoundError(f"Scene clip is missing: {relative}")
    if "\n" in str(path) or "\r" in str(path):
        raise ValueError("Scene clip paths cannot contain line breaks.")
    return path


class Beta2JoinScenes:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "clips": ("STRING", {"default": "[]", "multiline": True}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "join"
    OUTPUT_NODE = True
    CATEGORY = "Beta2/Scenes"

    def join(self, clips):
        names = json.loads(clips)
        if not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names):
            raise ValueError("Provide a nonempty JSON list of scene clip paths.")
        paths = [output_video(n) for n in names]
        target = paths[0].parent / f"joined_{uuid.uuid4().hex[:12]}.mp4"
        manifest = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", encoding="utf-8", delete=False) as handle:
                manifest = handle.name
                for path in paths:
                    escaped = path.as_posix().replace("'", "'\\''")
                    handle.write(f"file '{escaped}'\n")
            result = subprocess.run(
                [get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
                 "-f", "concat", "-safe", "0", "-protocol_whitelist", "file,pipe", "-i", manifest,
                 "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", str(target)],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            if result.returncode:
                target.unlink(missing_ok=True)
                raise RuntimeError(f"Could not join scene clips: {result.stderr[-2000:]}")
        finally:
            if manifest is not None:
                Path(manifest).unlink(missing_ok=True)
        relative = target.relative_to(Path(folder_paths.get_output_directory()).resolve())
        return {"ui": {"gifs": [{"filename": target.name, "subfolder": relative.parent.as_posix(),
                                 "type": "output", "format": "video/h264-mp4"}]}, "result": ()}


NODE_CLASS_MAPPINGS = {
    "Beta2SceneQueue": Beta2SceneQueue,
    "Beta2SaveLastFrame": Beta2SaveLastFrame,
    "Beta2JoinScenes": Beta2JoinScenes,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "Beta2SceneQueue": "Scene Queue - Run Scenes Here",
    "Beta2SaveLastFrame": "Save Scene Last Frame",
    "Beta2JoinScenes": "Join Saved Scenes",
}
WEB_DIRECTORY = "./web"
