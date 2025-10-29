import React, { useState } from 'react';

// Define common base addresses outside the component
const BASE_ADDRESS_PRESETS = [
  { name: "STM32 Flash (0x08000000)", address: "0x08000000" },
  { name: "ESP32 App (0x00010000)", address: "0x00010000" },
  { name: "AVR ATmega / 8-bit (0x00000000)", address: "0x00000000" },
  { name: "nRF52 App (0x00026000)", address: "0x00026000" },
];

/**
 * Component `App` - The main Intel HEX <-> BIN converter application.
 * Allows conversion in both directions directly in the browser.
 */
export default function App() {
  // Application mode: 'hexToBin' or 'binToHex'
  const [mode, setMode] = useState('hexToBin');
  
  // Message for the user (status, errors)
  const [message, setMessage] = useState('');
  
  // Loading state during file processing
  const [isLoading, setIsLoading] = useState(false);
  
  // State for the preset dropdown. Default to the common STM32 address.
  const [preset, setPreset] = useState(BASE_ADDRESS_PRESETS[0].address);
  
  // State for the custom address input field
  const [customAddress, setCustomAddress] = useState("0x0000");
  
  // Data line length for the HEX file (16 or 32 bytes)
  const [lineLength, setLineLength] = useState(16);

  /**
   * Handles input file change.
   * Starts the appropriate conversion process based on the current mode.
   */
  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (!file) {
      return;
    }

    setIsLoading(true);
    setMessage('');

    if (mode === 'hexToBin') {
      convertHexToBin(file);
    } else {
      convertBinToHex(file);
    }

    // Resets the file input to allow uploading the same file again
    event.target.value = null;
  };

  /**
   * Converts the uploaded Intel HEX file to a raw binary file (.bin).
   */
  const convertHexToBin = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const hexContent = e.target.result;
        const lines = hexContent.split(/\r?\n/);

        // Using an object for sparse data storage to manage memory efficiently
        const binaryData = {};
        let maxAddress = 0;
        let minAddress = Number.MAX_SAFE_INTEGER;
        let extendedLinearAddress = 0; // For type 04 records

        for (const line of lines) {
          if (!line.startsWith(':') || line.length < 11) {
            continue; // Skip empty lines or lines without a start code
          }

          // Converts HEX line (string) to an array of bytes (numbers)
          const bytes = line.substring(1).match(/.{1,2}/g).map(byte => parseInt(byte, 16));

          const byteCount = bytes[0];
          const address = (bytes[1] << 8) | bytes[2];
          const recordType = bytes[3];
          const data = bytes.slice(4, 4 + byteCount);
          const checksum = bytes[bytes.length - 1];

          // Checksum validation
          const calculatedChecksum = (0x100 - (bytes.slice(0, -1).reduce((acc, byte) => acc + byte, 0) & 0xFF)) & 0xFF;
          if (checksum !== calculatedChecksum) {
            throw new Error(`Checksum error in line: ${line}`);
          }

          switch (recordType) {
            case 0x00: // Data Record
              const fullAddress = (extendedLinearAddress << 16) | address;
              minAddress = Math.min(minAddress, fullAddress); // Find the lowest address
              for (let i = 0; i < data.length; i++) {
                binaryData[fullAddress + i] = data[i];
              }
              maxAddress = Math.max(maxAddress, fullAddress + data.length - 1); // Find the highest address
              break;

            case 0x01: // End of File (EOF)
              // Stop parsing
              break;

            case 0x04: // Extended Linear Address (ELA)
              extendedLinearAddress = (data[0] << 8) | data[1];
              break;
            
            // Other record types (02, 03, 05) are ignored here
          }
        }
        
        if (Object.keys(binaryData).length === 0) {
            throw new Error("The HEX file does not contain any data records (type 00).");
        }

        // Create the final binary file
        // The size is (max - min) + 1 to represent the actual data range
        const fileSize = (maxAddress - minAddress) + 1;
        const binArray = new Uint8Array(fileSize);
        
        // Fill with default 0xFF (standard for empty flash memory)
        binArray.fill(0xFF); 

        // Fill the array with data from the HEX file, offsetting by minAddress
        for (const [addr, byte] of Object.entries(binaryData)) {
          binArray[addr - minAddress] = byte;
        }

        downloadFile(binArray, file.name.replace(/\.[^/.]+$/, "") + ".bin", "application/octet-stream");
        setMessage("HEX to BIN conversion successful!");

      } catch (error) {
        console.error(error);
        setMessage(`Error: ${error.message}`);
      } finally {
        setIsLoading(false);
      }
    };
    reader.onerror = () => {
      setMessage("Could not read file.");
      setIsLoading(false);
    };
    reader.readAsText(file);
  };

  /**
   * Converts the uploaded raw binary file (.bin) to Intel HEX format.
   */
  const convertBinToHex = (file) => {
    // Determine the effective base address from state
    const effectiveBaseAddress = preset === "custom" ? customAddress : preset;
    const startAddress = parseInt(effectiveBaseAddress, 16);
    
    if (isNaN(startAddress)) {
      setMessage("Invalid base address format. Use '0x...' or '...'.");
      setIsLoading(false);
      return;
    }
    
    const bytesPerLine = parseInt(lineLength, 10);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target.result;
        const data = new Uint8Array(buffer);
        let hexString = "";
        let currentELA = -1; // Tracking current extended linear address

        for (let i = 0; i < data.length; i += bytesPerLine) {
          const chunk = data.slice(i, i + bytesPerLine);
          const currentAddress = startAddress + i;
          
          // Check if we need to generate a new ELA record (type 04)
          const newELA = (currentAddress >> 16) & 0xFFFF;
          if (newELA !== currentELA) {
            currentELA = newELA;
            const elaBytes = [(currentELA >> 8) & 0xFF, currentELA & 0xFF];
            hexString += createHexRecord(0, 0x04, elaBytes);
          }
          
          // Address for data record (only lower 16 bits)
          const recordAddress = currentAddress & 0xFFFF;
          hexString += createHexRecord(recordAddress, 0x00, Array.from(chunk));
        }

        // Add End of File (EOF) record
        hexString += createHexRecord(0, 0x01, []);
        
        downloadFile(hexString, file.name.replace(/\.[^/.]+$/, "") + ".hex", "text/plain");
        setMessage("BIN to HEX conversion successful!");

      } catch (error) {
        console.error(error);
        setMessage(`Error: ${error.message}`);
      } finally {
        setIsLoading(false);
      }
    };
    reader.onerror = () => {
      setMessage("Could not read file.");
      setIsLoading(false);
    };
    reader.readAsArrayBuffer(file);
  };

  /**
   * Helper function to create a single Intel HEX record (line).
   * @param {number} address - Address (16-bit)
   * @param {number} recordType - Record type (0x00, 0x01, 0x04, etc.)
   * @param {number[]} dataBytes - Array of data bytes
   * @returns {string} - Complete HEX record line
   */
  const createHexRecord = (address, recordType, dataBytes) => {
    const byteCount = dataBytes.length;
    const addressHi = (address >> 8) & 0xFF;
    const addressLo = address & 0xFF;

    const bytes = [byteCount, addressHi, addressLo, recordType, ...dataBytes];
    
    // Calculating checksum
    const sum = bytes.reduce((acc, byte) => acc + byte, 0);
    const checksum = (0x100 - (sum & 0xFF)) & 0xFF;

    // Formatting bytes to HEX string with zero padding
    const toHex = (byte) => byte.toString(16).padStart(2, '0').toUpperCase();

    const dataString = dataBytes.map(toHex).join('');
    
    return `:${toHex(byteCount)}${toHex(addressHi)}${toHex(addressLo)}${toHex(recordType)}${dataString}${toHex(checksum)}\n`;
  };

  /**
   * Helper function to initiate file download via the browser.
   * @param {*} data - Data (string or ArrayBuffer)
   * @param {string} fileName - File name
   * @param {string} mimeType - MIME type
   */
  const downloadFile = (data, fileName, mimeType) => {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  // Simple SVG spinner for loading state
  const spinner = (
    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
  );

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white font-sans p-4">
      <div className="w-full max-w-2xl bg-gray-800 rounded-xl shadow-2xl p-6 md:p-8">
        <h1 className="text-3xl font-bold text-center text-blue-400 mb-6">
          Intel HEX &harr; BIN Converter
        </h1>

        {/* Mode Switch */}
        <div className="flex justify-center mb-6 bg-gray-700 rounded-lg p-1">
          <button
            onClick={() => setMode('hexToBin')}
            className={`w-1/2 py-2 px-4 rounded-md font-semibold transition-all duration-300 ${
              mode === 'hexToBin' ? 'bg-blue-600 shadow-lg' : 'text-gray-400 hover:bg-gray-600'
            }`}
          >
            HEX &rarr; BIN
          </button>
          <button
            onClick={() => setMode('binToHex')}
            className={`w-1/2 py-2 px-4 rounded-md font-semibold transition-all duration-300 ${
              mode === 'binToHex' ? 'bg-blue-600 shadow-lg' : 'text-gray-400 hover:bg-gray-600'
            }`}
          >
            BIN &rarr; HEX
          </button>
        </div>

        {/* Conversion Panel */}
        <div className="space-y-6">
          {mode === 'hexToBin' ? (
            // Mode HEX -> BIN
            <div>
              <label htmlFor="hex-upload" className="block text-sm font-medium text-gray-300 mb-2">
                Select Intel HEX file (.hex)
              </label>
              <input
                id="hex-upload"
                type="file"
                accept=".hex"
                onChange={handleFileChange}
                disabled={isLoading}
                className="block w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 disabled:opacity-50"
              />
            </div>
          ) : (
            // Mode BIN -> HEX
            <div className="space-y-4">
              <div>
                <label htmlFor="bin-upload" className="block text-sm font-medium text-gray-300 mb-2">
                  Select binary file (.bin)
                </label>
                <input
                  id="bin-upload"
                  type="file"
                  accept=".bin"
                  onChange={handleFileChange}
                  disabled={isLoading}
                  className="block w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 disabled:opacity-50"
                />
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="preset-select" className="block text-sm font-medium text-gray-300 mb-2">
                    Base Address Preset
                  </label>
                  <select
                    id="preset-select"
                    value={preset}
                    onChange={(e) => setPreset(e.target.value)}
                    disabled={isLoading}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {BASE_ADDRESS_PRESETS.map(p => (
                      <option key={p.name} value={p.address}>{p.name}</option>
                    ))}
                    <option value="custom">-- Custom Address --</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="line-length" className="block text-sm font-medium text-gray-300 mb-2">
                    Bytes per line
                  </label>
                  <select
                    id="line-length"
                    value={lineLength}
                    onChange={(e) => setLineLength(Number(e.target.value))}
                    disabled={isLoading}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value={16}>16 bytes</option>
                    <option value={32}>32 bytes</option>
                  </select>
                </div>
              </div>

              {/* Conditionally show the custom input field */}
              {preset === "custom" && (
                <div className="pt-2">
                  <label htmlFor="base-address" className="block text-sm font-medium text-gray-300 mb-2">
                    Custom Base Address
                  </label>
                  <input
                    id="base-address"
                    type="text"
                    value={customAddress}
                    onChange={(e) => setCustomAddress(e.target.value)}
                    disabled={isLoading}
                    placeholder="0x..."
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}

            </div>
          )}

          {/* Status and button (button is hidden, action starts on file select) */}
          <div className="h-10 flex items-center justify-center">
            {isLoading ? (
              <div className="flex items-center text-gray-400">
                {spinner}
                Processing...
              </div>
            ) : (
              message && (
                <p className={`text-center font-medium ${message.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                  {message}
                </p>
              )
            )}
          </div>
        </div>

        <div className="text-center text-xs text-gray-500 mt-6">
          All conversions are done locally in your browser.
          <br />
          No files are uploaded to any server.
        </div>
      </div>
    </div>
  );
}

