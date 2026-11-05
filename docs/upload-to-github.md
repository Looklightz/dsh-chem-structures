# 把插件上传到 GitHub（零基础版）

这份指南假设你**没有装过 Git**、也没用过 GitHub。全程只需要浏览器，不需要命令行。

---

## 一、上传前检查

要上传的是插件文件夹 **`chem-structures` 里面的内容**（不是它的上一层，也不包括工作区里生成的 `chem-drawings`）。

打开这个文件夹确认有这些文件/目录：

```
package.json          ← 必须有，GitHub 仓库根目录就要看到它
cordis.patch.yml
index.js
render.cjs
client.js
README.md
LICENSE
.gitignore
icon.svg
locale/
docs/
vendor/               ← 里面有 7.4 MB 的 RDKit wasm，正常，别删
```

有一样不对就先别传。

---

## 二、注册 GitHub（已有账号可跳过）

1. 打开 <https://github.com>，点右上角 **Sign up**。
2. 按提示填邮箱、密码、用户名（用户名会成为仓库地址的一部分，建议用英文/数字/短横线）。
3. 验证邮箱后即可使用。

---

## 三、新建仓库

1. 登录后点右上角 **+** → **New repository**。
2. 填写：
   - **Repository name**：`dsh-chem-structures`（和 `package.json` 里的名字一致最省事）
   - **Description**：`让 DSH 在回答正文里直接画出分子结构式和反应方程式`（可自行修改）
   - 选择 **Public**（公开）
   - **不要**勾选 "Add a README file"、"Add .gitignore"、"Choose a license" —— 我们已经有这些文件了，勾了反而冲突
3. 点 **Create repository**。

---

## 四、上传文件（网页拖拽，无需 Git）

1. 在新仓库页面，点中间偏下的 **uploading an existing file** 链接
   （或右上角 **Add file → Upload files**）。
2. 打开资源管理器，进入 `chem-structures` 文件夹，**全选里面的所有文件和文件夹**，拖进网页的上传区域。
   - 直接拖文件夹也可以，GitHub 会保留 `locale/`、`docs/`、`vendor/` 这些子目录结构。
   - 注意：是拖**里面的内容**，不要把 `chem-structures` 文件夹本身拖进去，否则仓库里会多一层目录，README 不会显示在首页。
3. 等待上传（7.4 MB 的 wasm 需要一点时间）。
4. 在下方 **Commit changes** 处填一句说明，例如 `Initial commit: dsh-chem-structures v1.0.0`，然后点绿色按钮提交。

> 单个文件上限：网页上传是 25 MB，本项目最大文件约 7.4 MB，没问题，不需要 Git LFS。

---

## 五、上传后检查这 4 件事

1. **仓库首页能看到 README 内容**（不是只显示文件列表）。若没显示，说明多套了一层目录，见下面「常见坑」。
2. **README 里的图片正常显示**（`docs/preview-structure.png` 等）。
3. **右侧 About 区域显示 `MIT license`**（说明 LICENSE 被正确识别）。
4. **文件列表里直接看到 `package.json`、`index.js`**，而不是先看到一个 `chem-structures` 文件夹。

另外建议：点 About 旁边的齿轮，填 **Description**（一句话介绍）和 **Topics**：`dsh`、`dsh-plugin`、`chemistry`、`smiles`、`rdkit`。

---

## 六、别人怎么安装（也是你自己的安装地址）

仓库地址就是安装地址：

```
https://github.com/你的用户名/dsh-chem-structures
```

在 DSH 里：「插件」→「添加插件」→「安装第三方插件」→ 粘贴上面的地址 → 安装。
这份说明已经写进 README 的「安装」章节了。

---

## 七、以后更新代码怎么办

- **改一两个文件**：在 GitHub 仓库里点开文件 → 右上角铅笔图标 → 修改 → 底部 **Commit changes**。
- **改多个文件**：回到仓库首页 → **Add file → Upload files**，把改过的文件重新拖进去覆盖，再提交。
- 改完记得把 `package.json` 里的 `"version"` 加一（如 `1.0.1`），方便别人分辨新旧版本。

---

## 八、可选：用 GitHub Desktop（以后频繁改动更省事）

1. 下载安装 [GitHub Desktop](https://desktop.github.com/)。
2. 打开后登录你的 GitHub 账号。
3. 菜单 **File → Add local repository**，选择 `chem-structures` 文件夹。
4. 提示「不是 Git 仓库」时点 **create a repository**，然后点右上角 **Publish repository**。
5. 勾选是否公开，发布即可。

它会把文件夹同步成一个仓库，以后改动只需要：在软件里看到变更 → 写一句说明 → **Commit** → **Push**。

---

## 九、常见坑

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 仓库首页只显示文件列表，不显示 README | 文件被套在了一层文件夹里 | 把该文件夹里的内容移到仓库根目录：网页上无法直接移动，最简单是删掉仓库重传，拖文件时注意拖「里面的内容」 |
| README 里图片裂开 | 图片没上传，或路径不对 | 确认 `docs/preview-*.png` 已上传，且 README 里写的是相对路径 `docs/xxx.png` |
| 右侧不显示 MIT license | LICENSE 没上传或文件名不对 | 文件名必须是 `LICENSE`（全大写、无扩展名） |
| 上传后插件装不上 | 仓库缺 `package.json`，或 `package.json` 里没有 `dsh.bundle.patch` | 检查仓库根目录的 `package.json` 是否与本地一致 |
| 网页上传很慢 | 网络访问 GitHub 慢 | 换网络/代理，或用 GitHub Desktop 重试 |

---

## 十、上传完成后

1. 复制仓库地址，发给想用的人（或贴到社区）。
2. 自己在 DSH 里用仓库地址装一遍，确认别人也能装成功。
3. 这份指南可以留在 `docs/` 里，也可以删掉，不影响插件运行。
