import sys

path = sys.argv[1] if len(sys.argv) > 1 else 'docker-entrypoint.sh'
try:
    with open(path, 'rb') as f:
        content = f.read()

    content = content.replace(b'\r\n', b'\n')

    with open(path, 'wb') as f:
        f.write(content)

    print(f"Fixed line endings for {path}")
except OSError as e:
    print(f"Failed to process {path}: {e}", file=sys.stderr)
    sys.exit(1)
