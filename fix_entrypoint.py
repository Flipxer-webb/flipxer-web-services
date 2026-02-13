
import os

path = 'docker-entrypoint.sh'
with open(path, 'rb') as f:
    content = f.read()

content = content.replace(b'\r\n', b'\n')

with open(path, 'wb') as f:
    f.write(content)

print(f"Fixed line endings for {path}")
