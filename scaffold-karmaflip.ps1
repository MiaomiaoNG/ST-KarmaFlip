Continue = 'Stop'

# 1) Create modular source folder
[System.IO.Directory]::CreateDirectory((Join-Path (Get-Location) 'src')) | Out-Null

# 2) manifest.json
@'
{
  "name": "API随机临幸",
  "version": "1.0.0",
  "description": "KarmaFlip: A modular API switcher with random weight, cooldown, and pity system.",
  "author": "MiaoMiao",
  "main": "index.js"
}
'@ | Out-File -FilePath (Join-Path (Get-Location) 'manifest.json') -Encoding UTF8

# 3) style.css
@'
.karma-flip-panel { display: flex; flex-direction: column; padding: 10px; }
'@ | Out-File -FilePath (Join-Path (Get-Location) 'style.css') -Encoding UTF8

# 4) index.js
@'
const KarmaFlip = (function () {
    const moduleName = "API随机临幸 (KarmaFlip)";

    async function init() {
        console.log([] Extension successfully loaded and initialized!);
        // We will build the UI and Interceptor in the modular src folder later.
    }

    return {
        init: init
    };
})();

jQuery(async () => {
    await KarmaFlip.init();
});
'@ | Out-File -FilePath (Join-Path (Get-Location) 'index.js') -Encoding UTF8

Write-Host 'KarmaFlip scaffold completed.'
