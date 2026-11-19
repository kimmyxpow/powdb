# Shortcuts

Every keyboard shortcut in PowDBs. `Mod` means `Ctrl` on Windows and Linux, or `⌘` on macOS. Press `?` in the app to see a shorter list, with a search box.

## General

| Shortcut  | What it does                                                |
| --------- | ----------------------------------------------------------- |
| `Mod + K` | Open the command palette (jump to a table, view, or action) |
| `/`       | Move focus to the object filter in the sidebar              |
| `?`       | Show the shortcut list                                      |
| `Mod + B` | Show or hide the sidebar                                    |

## Table data: moving around

| Shortcut              | What it does                  |
| --------------------- | ----------------------------- |
| `↑` `↓` `←` `→`       | Move between cells            |
| `Mod + ↑`             | Go to the first row           |
| `Mod + ↓`             | Go to the last row            |
| `Home`                | Go to the first column        |
| `End`                 | Go to the last column         |
| `PageUp` / `PageDown` | Move up or down one screen    |
| `Tab`                 | Next cell                     |
| `Shift + Tab`         | Previous cell                 |
| `Space`               | Open or close the row details |
| `Mod + F`             | Search the rows               |
| `Alt + Shift + R`     | Refresh the rows              |

## Table data: editing

| Shortcut                | What it does                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `Enter` or `F2`         | Edit the cell (or just start typing)                                                                  |
| `Shift + Enter`         | Open the calendar or the large editor                                                                 |
| `Alt + ↓`               | Show or hide the calendar                                                                             |
| `Enter` (while editing) | Keep the edit and move down                                                                           |
| `Tab` (while editing)   | Keep the edit and move right                                                                          |
| `Esc` (while editing)   | Cancel the edit                                                                                       |
| `Delete`                | Clear the cell (sets NULL, if the column allows NULL). With rows selected, delete those rows instead. |
| `Mod + C`               | Copy the cell, or the selected rows                                                                   |
| `Mod + V`               | Paste from a spreadsheet                                                                              |
| `Mod + A`               | Select all rows                                                                                       |
| `Alt + Shift + N`       | Add a row                                                                                             |
| `Alt + Shift + D`       | Duplicate the row                                                                                     |
| `Mod + Delete`          | Delete the row, or the selected rows                                                                  |
| `Mod + Z`               | Undo                                                                                                  |
| `Mod + Shift + Z`       | Redo (`Mod + Y` also works)                                                                           |
| `Mod + S`               | Save table changes                                                                                    |
| `Esc`                   | Clear the selection                                                                                   |

Unsaved changes stay as a draft until you press `Mod + S`, which saves them in one transaction.

## SQL editor

| Shortcut              | What it does                           |
| --------------------- | -------------------------------------- |
| `Mod + Enter`         | Run the selection, or the whole script |
| `Mod + Shift + Enter` | Run the statement under the cursor     |
| `Mod + .`             | Cancel the running query               |
| `Mod + S`             | Save the query                         |
| `Shift + Alt + F`     | Format SQL                             |
| `Ctrl + Space`        | Show suggestions (autocomplete)        |
| `Tab`                 | Accept the highlighted suggestion      |
| `Mod + /`             | Comment or uncomment lines             |

`Ctrl + Space` is the same on macOS. The editor uses Ctrl there, not ⌘.
