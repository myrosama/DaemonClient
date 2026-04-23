import os
import re

directory = "/home/sadrikov49/Desktop/Daemonclient/DaemonClient/immich/web/src"

for root, _, files in os.walk(directory):
    for file in files:
        if file.endswith('.svelte') or file.endswith('.ts') or file.endswith('.js'):
            filepath = os.path.join(root, file)
            with open(filepath, 'r') as f:
                content = f.read()
            
            # Fix dangling commas in import lists: "import { A, , B } from"
            # It can be multiple spaces and commas.
            # Easiest way is to match the content inside the {} of import { ... } from '@immich/ui'
            def fix_import_content(match):
                inner = match.group(1)
                # Split by comma, strip whitespace, remove empty, join by comma
                parts = [p.strip() for p in inner.split(',') if p.strip()]
                return f"import {{{', '.join(parts)}}} from '@immich/ui'"

            new_content = re.sub(r'import\s+\{([^}]+)\}\s+from\s+[\'"]@immich/ui[\'"]', fix_import_content, content)
            
            if new_content != content:
                with open(filepath, 'w') as f:
                    f.write(new_content)

print("Commas fixed.")
