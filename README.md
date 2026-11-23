# ComfyUI Output Gallery

把 `ComfyUI/output` 变成一个全屏图库：浏览、看大图、多选、批量移入 Windows 回收站。
不注册节点，不改动 ComfyUI 源码、工作流和生成流程；没有数据库，也没有前端框架。

## 打开方式

- 顶部操作栏的「图库」按钮
- 快捷键 `Ctrl + Shift + G`
- 命令面板（`Ctrl + K`）搜索「打开 Output 图库」

`Esc` 关闭图库，回到原来的画布，工作流不受影响。

## 功能

- 递归扫描 `output/`（含子目录），支持 png / jpg / jpeg / webp / bmp / gif / tif / tiff
- 自适应网格 + 懒加载缩略图（WebP 320px，缓存在 `ComfyUI/temp/output_gallery_thumbs`）
- 按文件名搜索、按生成时间正序/倒序、滚动到底自动加载下一页（每页 100 张）
- 大图预览：滚轮缩放、双击复位、`←` `→` 切图、`Esc` 关闭，显示文件名 / 目录 / 尺寸 / 体积 / 时间
- **删除模式**：点一下「删除模式」按钮，之后单击图片就是选中（不会弹大图），Shift 连选、可框选；
  再点一次或按 `Esc` 退出，点击恢复成看大图
- 批量删除：二次确认后移入系统回收站（send2trash），后端强制校验路径必须落在 `output/` 内，
  回收站失败时直接报错，不会退化成永久删除

## 操作对照

| 操作 | 普通模式 | 删除模式 |
| --- | --- | --- |
| 单击图片 | 打开大图 | 选中 / 取消选中 |
| Shift + 单击 | 连续选中 | 连续选中 |
| Ctrl + 单击 | 加选 | 加选 |
| 空白处拖动 | 框选 | 框选 |
| 左上角勾选框 | 选中 / 取消选中 | 选中 / 取消选中 |
| 双击图片 | 选中 / 取消选中 | — |
| `Enter`（卡片聚焦） | 打开大图 | 选中 / 取消选中 |
| `Esc` | 关闭图库 | 退出删除模式 |

## 安装

在 ComfyUI 的 `custom_nodes` 目录里克隆：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/yucode-kk/ComfyUI_Output_Gallery.git
```

也可以直接下载仓库压缩包，把 `ComfyUI_Output_Gallery` 整个文件夹放进 `ComfyUI/custom_nodes/`。

然后在 ComfyUI 根目录安装依赖（便携版用自带的 python）：

```bat
python_embeded\python.exe -m pip install send2trash
```

普通安装用 `pip install send2trash`，或者 `pip install -r ComfyUI/custom_nodes/ComfyUI_Output_Gallery/requirements.txt`。

重启 ComfyUI，浏览器按 `Ctrl + F5` 强制刷新一次前端缓存。

缺少 `send2trash` 时浏览、预览、选择都正常，只有删除接口返回 503 并提示装依赖。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/output-gallery/list?offset=&limit=&q=&order=` | 图片列表（相对路径 + 尺寸 + 时间） |
| GET | `/output-gallery/thumb?path=&w=` | 缩略图（WebP，带缓存头） |
| GET | `/output-gallery/image?path=` | 原图 |
| POST | `/output-gallery/trash` | `{"paths": [...]}` 批量移入回收站 |

## 安全边界

- 所有路径参数都做 `resolve()` + `is_relative_to(output)` 校验，拒绝 `../`、绝对路径和目录本身
- 只接受图片后缀，只删普通文件
- 只走系统回收站，不直接 `os.remove()`，删错了可以还原
- 不向浏览器暴露磁盘绝对路径，只发相对 `output/` 的路径

## 卸载

删掉 `ComfyUI/custom_nodes/ComfyUI_Output_Gallery` 目录，顺手清一下缩略图缓存
`ComfyUI/temp/output_gallery_thumbs`，重启 ComfyUI 即可。

## 兼容性

- ComfyUI 0.3.x 及以上（用到 `actionBarButtons` 操作栏接口；老前端请用 `Ctrl + Shift + G` 打开）
- Python 3.9+
- Windows / macOS / Linux 都可以，回收站由 send2trash 适配各平台

## 结构

```
ComfyUI_Output_Gallery/
├── __init__.py       # 入口，注册 web 目录
├── gallery_api.py    # 扫描 / 缩略图 / 原图 / 回收站
├── requirements.txt
└── web/
    ├── gallery.js    # 图库页面、选择、预览、删除
    └── gallery.css
```

## License

MIT
