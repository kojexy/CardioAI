# PyInstaller spec: CardioAI desktop (patients, history, comparison, ECG viewer).
# Build from the repository root:  pyinstaller desktop/cardioai.spec
# Neural networks are not bundled (about 3 GB); the app uses a full install if it finds one.
import sys
from pathlib import Path

root = Path(SPECPATH).parent
reader = root / 'outputs' / 'ecg-reader'
datas = [(str(root / 'app'), 'app')]
for name in ['DeepECG-local.html', 'ECG301-reader.html', 'research-labels-ru.json',
             'ecgfounder-source-manifest.json', 'deepecg-metadata.template.json']:
    datas.append((str(reader / name), 'outputs/ecg-reader'))
datas.append((str(reader / 'verification'), 'outputs/ecg-reader/verification'))
# Model scripts run later by the program's own Python, so they ship as plain files too.
for path in list(reader.glob('*.py')) + [reader / 'fairseq-python312-compat.patch']:
    if not path.name.startswith('test_'):
        datas.append((str(path), 'outputs/ecg-reader'))
datas += [(str(root / 'scripts' / 'setup_models.py'), 'scripts'), (str(root / 'model-assets'), 'model-assets'),
          (str(root / 'requirements.txt'), '.')]

a = Analysis(
    [str(root / 'desktop' / 'cardioai_desktop.py')],
    pathex=[str(reader)],
    datas=datas,
    hiddenimports=['deepecg_local_server', 'patient_store', 'model_setup', 'folder_worker', 'ecg_reader', 'founder_report', 'research_report'],
    excludes=['numpy', 'scipy', 'torch', 'pandas', 'matplotlib', 'tkinter'],
)
pyz = PYZ(a.pure)
icon = str(root / 'desktop' / ('icon.icns' if sys.platform == 'darwin' else 'icon.ico'))
# UTF-8 mode: Windows would otherwise read and write text files in the ANSI code page.
exe = EXE(pyz, a.scripts, [('X utf8_mode=1', None, 'OPTION')], exclude_binaries=True, name='CardioAI', console=False,
          icon=icon if Path(icon).is_file() else None)
coll = COLLECT(exe, a.binaries, a.datas, name='CardioAI')
if sys.platform == 'darwin':
    app = BUNDLE(coll, name='CardioAI.app', icon=icon if Path(icon).is_file() else None,
                 bundle_identifier='io.github.kojexy.cardioai',
                 info_plist={'NSHighResolutionCapable': True, 'CFBundleShortVersionString': '2.3.0',
                             'CFBundleDevelopmentRegion': 'ru', 'CFBundleLocalizations': ['ru']})
