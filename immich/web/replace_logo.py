import os
import re

directory = "/home/sadrikov49/Desktop/Daemonclient/DaemonClient/immich/web/src"

for root, _, files in os.walk(directory):
    for file in files:
        if file.endswith('.svelte'):
            filepath = os.path.join(root, file)
            with open(filepath, 'r') as f:
                content = f.read()
            
            # Remove Logo from imports
            content = re.sub(r'import\s+\{([^}]*)\bLogo\b([^}]*)\}\s+from\s+[\'"]@immich/ui[\'"];?', 
                lambda m: f"import {{{m.group(1)}{m.group(2)}}} from '@immich/ui';" if m.group(1).strip() or m.group(2).strip() else "", 
                content)
            
            # Clean up empty imports like import { ,  } from '@immich/ui';
            content = re.sub(r'import\s*\{\s*,?\s*\}\s*from\s*[\'"]@immich/ui[\'"];?', '', content)

            # Replace <Logo ... /> with <img ... />
            def replace_logo_tag(match):
                tag = match.group(0)
                # extract class
                class_match = re.search(r'class=(["\'])(.*?)\1', tag)
                class_str = class_match.group(2) if class_match else ""
                
                class_bind_match = re.search(r'class=\{([^}]+)\}', tag)
                if class_bind_match:
                    class_str += f" {{{class_bind_match.group(1)}}}"
                
                # Check size
                if 'size="giant"' in tag:
                    class_str += " h-24 w-auto"
                elif 'size="tiny"' in tag:
                    class_str += " h-4 w-auto"
                elif 'size="small"' in tag:
                    class_str += " h-6 w-auto"
                elif 'variant="inline"' in tag:
                    class_str += " h-8 w-auto"
                elif 'variant="icon"' in tag:
                    class_str += " h-10 w-auto"
                elif 'size=' in tag:
                    class_str += " h-10 w-auto" # default fallback
                else:
                    class_str += " h-10 w-auto"

                # Check if class is empty
                class_attr = f' class="{class_str.strip()}"' if class_str.strip() else ''
                
                return f'<img src="/daemonclient-logo.png" alt="DaemonClient"{class_attr} />'

            # It could be self closing <Logo ... />
            content = re.sub(r'<Logo\s+[^>]*/>', replace_logo_tag, content)
            
            # Handle non-self-closing <Logo> ... </Logo> just in case (though unlikely for a logo)
            content = re.sub(r'<Logo\s+[^>]*>.*?</Logo>', replace_logo_tag, content, flags=re.DOTALL)

            with open(filepath, 'w') as f:
                f.write(content)

print("Replacement complete.")
