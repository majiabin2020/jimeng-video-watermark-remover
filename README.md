# 即梦视频无水印解析工具

![Contributors](https://img.shields.io/github/contributors/majiabin2020/jimeng-video-watermark-remover)
![License](https://img.shields.io/github/license/majiabin2020/jimeng-video-watermark-remover)

一个用于解析即梦（Jimeng）APP生成的AI视频并去除水印的工具。支持静态水印和动态水印（尾部水印）的去除，提供无水印视频下载。

## 功能特性

- 解析即梦视频分享链接
- 自动检测并去除静态水印
- 自动检测并去除动态水印（尾部水印）
- 提供无水印视频下载
- 支持视频预览
- 简洁易用的Web界面
- 本地运行，保护隐私

## 技术栈

- Node.js
- Playwright（浏览器自动化）
- FFmpeg（视频处理）
- 原生HTML/CSS/JavaScript前端

## 安装与运行

### 方式一：直接运行（推荐）

1. 确保已安装 [Node.js](https://nodejs.org/)（版本18或更高）
2. 克隆或下载本项目
3. 在项目目录中安装依赖：
   ```bash
   npm install
   ```
4. 启动服务：
   ```bash
   npm start
   ```
5. 打开浏览器访问 `http://localhost:3000`

### 方式二：使用打包版本

1. 在项目目录中运行打包命令：
   ```bash
   npm run release
   ```
2. 在 `dist` 目录中找到生成的可执行文件
3. 运行可执行文件，自动打开浏览器

## 使用说明

1. 启动工具后，浏览器会自动打开操作界面
2. 首次使用需要扫码登录即梦账号（通过抖音扫码）
3. 粘贴即梦视频分享链接到输入框
4. 点击"解析"按钮
5. 等待解析完成，查看视频信息
6. 选择下载无水印视频或原视频

## 注意事项

- 本工具仅供学习交流使用
- 请尊重原创内容版权
- 仅支持即梦平台生成的视频
- 需要网络连接才能正常工作
- 登录状态会保存在本地，下次使用无需重复登录

## 项目结构

```
jimeng/
├── server.js          # 后端服务器主程序
├── public/            # 前端静态文件
│   └── index.html     # 前端界面
├── data/              # 数据存储目录
├── scripts/           # 构建脚本
├── package.json       # 项目配置
└── README.md          # 项目说明
```

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm start

# 打包为可执行文件
npm run release
```

## 贡献者

- [majiabin2020](https://github.com/majiabin2020) - 项目创建者和主要维护者

## 许可证

MIT许可证 - 详见 [LICENSE](LICENSE) 文件

## 免责声明

本工具仅供学习和研究使用，不得用于商业用途。用户需自行承担使用风险，开发者不承担任何责任。请遵守相关法律法规和平台服务条款。