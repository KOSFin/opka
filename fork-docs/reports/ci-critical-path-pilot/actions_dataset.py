"""Lossless compressed public Actions datasets for this bounded audit."""
import gzip,json,pathlib

def has_json(path):
    path=pathlib.Path(path)
    return path.exists() or pathlib.Path(str(path)+'.gz').exists()

def read_json(path):
    path=pathlib.Path(path)
    if path.exists():return json.loads(path.read_text())
    return json.loads(gzip.decompress(pathlib.Path(str(path)+'.gz').read_bytes()))

def write_json(path,data):
    path=pathlib.Path(path)
    raw=(json.dumps(data,indent=2)+'\n').encode()
    if len(raw)>16384:
        compressed=gzip.compress(raw,mtime=0)
        assert gzip.decompress(compressed)==raw
        pathlib.Path(str(path)+'.gz').write_bytes(compressed)
        if path.exists():path.unlink()
    else:path.write_bytes(raw)
