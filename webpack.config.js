const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    'service-worker': './src/background/service-worker.js',
    content: './src/content/bridge.js',
    'popup/popup': './src/popup/popup.js',
    'options/options': './src/options/options.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'src/popup/popup.html', to: 'popup/' },
        { from: 'src/popup/popup.css', to: 'popup/' },
        { from: 'src/options/options.html', to: 'options/' },
        { from: 'src/options/options.css', to: 'options/' },
        { from: 'icons/', to: 'icons/' },
      ],
    }),
  ],
  resolve: {
    extensions: ['.js'],
  },
  devtool: false,
};
