This folder is for **downloaded external assets** (usually large binaries) that we keep out of git.

### Vehicle tires (CC0, Poly Haven)

To fetch a realistic tire model + textures used by the runtime wheel overlay, run:

```bash
bash tools/fetch_polyhaven_old_tyre_2k.sh
```

This downloads into:

- `public/external/polyhaven/old_tyre_2k/old_tyre_2k.gltf`
- `public/external/polyhaven/old_tyre_2k/old_tyre.bin`
- `public/external/polyhaven/old_tyre_2k/textures/*`

The runtime default URL is:

- `/external/polyhaven/old_tyre_2k/old_tyre_2k.gltf`

License: CC0 (see `https://polyhaven.com/license`).

