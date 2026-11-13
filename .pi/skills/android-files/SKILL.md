---
name: android-files
description: Read, search and edit files on an Android phone with DAVE's file tools (list_dir, read_file, write_file, edit_file, move_path, delete_path, search_files, file_info). Use only when pi runs in Termux on Android and the task involves files on the phone.
---

# Android files

- Use list_dir or search_files first, then read_file. Change files with edit_file; use write_file for new files.
- You can reach Termux home, plus one Android folder if the user has mounted it. Shared storage is otherwise closed.
- On an "outside Termux home" error, tell the user they can run `/dave:android mount <folder>`. Never try another route, including bash.
- A "protected DAVE/Pi path" error means the file controls your own permissions. Leave it alone and tell the user.
- delete_path is off unless the user runs `/dave:android delete on`.
- read_file pages big files: follow the next-offset hint.
