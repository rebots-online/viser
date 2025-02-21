"""WebGL-based Gaussian splat rendering. This is still under developmentt."""

from __future__ import annotations

import time
from pathlib import Path
from typing import TypedDict

import numpy as onp
import numpy.typing as onpt
import tyro
import viser
from plyfile import PlyData
from viser import transforms as tf


class SplatFile(TypedDict):
    """Data loaded from an antimatter15-style splat file."""

    centers: onpt.NDArray[onp.floating]
    """(N, 3)."""
    rgbs: onpt.NDArray[onp.floating]
    """(N, 3). Range [0, 1]."""
    opacities: onpt.NDArray[onp.floating]
    """(N, 1). Range [0, 1]."""
    covariances: onpt.NDArray[onp.floating]
    """(N, 3, 3)."""


def load_splat_file(splat_path: Path, center: bool = False) -> SplatFile:
    """Load an antimatter15-style splat file."""
    splat_buffer = splat_path.read_bytes()
    bytes_per_gaussian = (
        # Each Gaussian is serialized as:
        # - position (vec3, float32)
        3 * 4
        # - xyz (vec3, float32)
        + 3 * 4
        # - rgba (vec4, uint8)
        + 4
        # - ijkl (vec4, uint8), where 0 => -1, 255 => 1.
        + 4
    )
    assert len(splat_buffer) % bytes_per_gaussian == 0
    num_gaussians = len(splat_buffer) // bytes_per_gaussian
    print("Number of gaussians to render: ", f"{num_gaussians=}")

    # Reinterpret cast to dtypes that we want to extract.
    splat_uint8 = onp.frombuffer(splat_buffer, dtype=onp.uint8).reshape(
        (num_gaussians, bytes_per_gaussian)
    )
    scales = splat_uint8[:, 12:24].copy().view(onp.float32)
    wxyzs = splat_uint8[:, 28:32] / 255.0 * 2.0 - 1.0
    Rs = onp.array([tf.SO3(wxyz).as_matrix() for wxyz in wxyzs])
    covariances = onp.einsum(
        "nij,njk,nlk->nil", Rs, onp.eye(3)[None, :, :] * scales[:, None, :] ** 2, Rs
    )
    centers = splat_uint8[:, 0:12].copy().view(onp.float32)
    if center:
        centers -= onp.mean(centers, axis=0, keepdims=True)
    print("Splat file loaded")
    return {
        "centers": centers,
        # Colors should have shape (N, 3).
        "rgbs": splat_uint8[:, 24:27] / 255.0,
        "opacities": splat_uint8[:, 27:28] / 255.0,
        # Covariances should have shape (N, 3, 3).
        "covariances": covariances,
    }


def load_ply_file(ply_file_path: Path, center: bool = False) -> SplatFile:
    plydata = PlyData.read(ply_file_path)
    vert = plydata["vertex"]
    sorted_indices = onp.argsort(
        -onp.exp(vert["scale_0"] + vert["scale_1"] + vert["scale_2"])
        / (1 + onp.exp(-vert["opacity"]))
    )
    numgaussians = len(vert)
    print("Number of gaussians to render: ", numgaussians)
    colors = onp.zeros((numgaussians, 3))
    opacities = onp.zeros((numgaussians, 1))
    positions = onp.zeros((numgaussians, 3))
    wxyzs = onp.zeros((numgaussians, 4))
    scales = onp.zeros((numgaussians, 3))
    for idx in sorted_indices:
        v = plydata["vertex"][idx]
        position = onp.array([v["x"], v["y"], v["z"]], dtype=onp.float32)
        scale = onp.exp(
            onp.array([v["scale_0"], v["scale_1"], v["scale_2"]], dtype=onp.float32)
        )

        rot = onp.array(
            [v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], dtype=onp.float32
        )
        SH_C0 = 0.28209479177387814
        color = onp.array(
            [
                0.5 + SH_C0 * v["f_dc_0"],
                0.5 + SH_C0 * v["f_dc_1"],
                0.5 + SH_C0 * v["f_dc_2"],
            ]
        )
        opacity = 1 / (1 + onp.exp(-v["opacity"]))
        wxyz = rot / onp.linalg.norm(rot)  # normalize
        scales[idx] = scale
        colors[idx] = color
        opacities[idx] = onp.array([opacity])
        positions[idx] = position
        wxyzs[idx] = wxyz

    Rs = onp.array([tf.SO3(wxyz).as_matrix() for wxyz in wxyzs])
    covariances = onp.einsum(
        "nij,njk,nlk->nil", Rs, onp.eye(3)[None, :, :] * scales[:, None, :] ** 2, Rs
    )
    if center:
        positions -= onp.mean(positions, axis=0, keepdims=True)
    print("PLY file loaded")
    return {
        "centers": positions,
        # Colors should have shape (N, 3).
        "rgbs": colors,
        "opacities": opacities,
        # Covariances should have shape (N, 3, 3).
        "covariances": covariances,
    }


def main(splat_paths: tuple[Path, ...], test_multisplat: bool = False) -> None:
    server = viser.ViserServer(share=True)
    server.gui.configure_theme(dark_mode=True)
    gui_reset_up = server.gui.add_button(
        "Reset up direction",
        hint="Set the camera control 'up' direction to the current camera's 'up'.",
    )

    @gui_reset_up.on_click
    def _(event: viser.GuiEvent) -> None:
        client = event.client
        assert client is not None
        client.camera.up_direction = tf.SO3(client.camera.wxyz) @ onp.array(
            [0.0, -1.0, 0.0]
        )

    for i, splat_path in enumerate(splat_paths):
        if splat_path.suffix == ".splat":
            splat_data = load_splat_file(splat_path, center=True)
        elif splat_path.suffix == ".ply":
            splat_data = load_ply_file(splat_path, center=True)
        else:
            raise SystemExit("Please provide a filepath to a .splat or .ply file.")

        server.scene.add_transform_controls(f"/{i}")
        server.scene._add_gaussian_splats(
            f"/{i}/gaussian_splats",
            centers=splat_data["centers"],
            rgbs=splat_data["rgbs"],
            opacities=splat_data["opacities"],
            covariances=splat_data["covariances"],
        )

    while True:
        time.sleep(10.0)


if __name__ == "__main__":
    tyro.cli(main)
