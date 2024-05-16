# Real-Time Share App

This is a real-time web application built with Node.js, Express, Multer, and Socket.IO. The application allows users to share text and files between multiple devices without requiring login or registration. The shared text and files are updated automatically in real-time between devices. It is intended for fast sharing text and files between multiple devices.

<img src="/images/frontend.png" width="800">

<img src="/images/batch.png" width="800">

## Features

- Directly access the clipboard, no rooms or login required.
- Real-time text sharing between multiple devices
- File upload and deletion with real-time updates
- Download files directly using `curl` or a web browser
- Get the text directly using `curl`
- Simple code
- Lightweight

## Prerequisites

- Node.js (v12 or higher)
- npm (v6 or higher)

## Installation

1. Clone the repository:

  ```bash
  git clone https://github.com/SaidTorres3/realtime-clipboard.git
  cd realtime-share-app
  ```

2. Install the dependencies:

  ```bash
  npm install
  ```

## Usage

1. Start the server:

  ```bash
  node server.js
  ```

  The default host is `0.0.0.0` and the default port is `8088`.

  To specify a custom host and port, use the following command:

  ```bash
  node server.js -a 0.0.0.0 -p 8088
  ```

2. Open your web browser and navigate to `http://localhost:8088` to use the application. (Replace `localhost` with the IP of your machine to see it on another device)

  - To share text, simply type in the textarea, and it will be updated in real-time across all connected devices.
  - To upload a file, use the file upload form. The uploaded file will be listed and available for download or deletion.

## API

### Get Shared Text

To get the shared text using curl:

  ```bash
  curl http://localhost:8088
  ```

### List Files

To list the uploaded files:

  ```bash
  curl http://localhost:8088/files
  ```

### Download a Specific File

To download a specific file:

  ```bash
  curl http://localhost:8088/files/yourfilename.ext --output yourfilename.ext
  ```

### Upload a File

 ```bash
  curl -F "file=@yourfilename.ext" http://localhost:8088/upload
  ```

### Delete a File

  ```bash
  curl -X DELETE http://localhost:8088/files/yourfilename.ext
  ```

## File Structure

- `server.js`: The main server file that sets up the Express server, handles file uploads, deletions, and real-time updates.
- `views/index.ejs`: The main view template for the web interface.
- `uploads/`: The directory where uploaded files are stored.

## License

This project is licensed under the MIT License - see the `LICENSE` file for details.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request.

## Acknowledgements

- Express
- Multer
- Socket.IO
- EJS
