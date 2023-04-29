import { useState, useEffect, useMemo, useRef } from "react";
import { Trans } from 'react-i18next';
import { Link } from "react-router-dom";
import { Popup, Image } from "semantic-ui-react";
import { BarcodeProfiles } from "../common/Types";
import { parseTimeSpan } from "../common/datetime";
import PropTypes from "prop-types";
import { dynamicDebouncer } from "../common/dynamicDebouncer";
import { AppEvents, Events } from "../common/events";
import useSound from 'use-sound';
import boopSfx from '../audio/softbeep.mp3';
import { fetchApi } from '../common/fetchApi';
import { copyString } from "../common/Utils";

// this value will be replaced by the Barcode config
// lower values might fail to detect scans
const DefaultDebounceIntervalMs = 80;
// lower values will falsely detect scans, higher may fail on short barcodes
const MinBufferLengthToAccept = 15; 
const AbortBufferTimerMs = 2000;
// if any keystrokes have a delay between them greater than this value, the buffer will be dropped
const MaxKeystrokeThresholdMs = 200;
const MinKeystrokesToConsiderScanningEvent = 10;

/**
 * Handles generic barcode scanning input by listening for batches of key presses
 */
export function BarcodeScannerInput({ listening, minInputLength, onReceived, helpUrl, swallowKeyEvent, passThrough, enableSound, config, onSetConfig, id, onDisabled }) {
	const IsDebug = true;
	const [barcodeConfig, setBarcodeConfig] = useState(config || {
		enabled: true,
		bufferTime: "00:00:00.150",
		barcodePrefix2D: "[)>",
		profile: BarcodeProfiles.Default
	});
  const [isKeyboardListening, setIsKeyboardListening] = useState(listening || true);
	const [previousIsKeyboardListeningState, setPreviousIsKeyboardListeningState] = useState(listening || true);
	const [playScanSound] = useSound(boopSfx, { soundEnabled: true, volume: 1 });
	const [isReceiving, setIsReceiving] = useState(false);
	const isStartedReading = useRef(false);
	const timerRef = useRef(null);
	const listeningRef = useRef(isKeyboardListening);
	const keyBufferRef = useRef([]);
	const playScanSoundRef = useRef(playScanSound);
	const keyTimes = useRef([]);
	const lastKeyTime = useRef(0);

  const onReceivedBarcodeInput = (e, buffer) => {
    if (buffer.length < MinBufferLengthToAccept && processKeyBuffer(buffer, barcodeConfig.barcodePrefix2D.length) !== barcodeConfig.barcodePrefix2D) {
			keyBufferRef.current.length = 0;
			if(IsDebug) console.log('timeout: barcode dropped input', buffer);
			const maxTime = getMaxValueFast(keyTimes.current, 1);
			if(IsDebug) console.log(`keytimes maxtime '${maxTime}'`, keyTimes.current);
			keyTimes.current = [];
    	return; // drop and ignore input
		} else {
			// if keytimes has any times over a max threshold, drop input
			const maxTime = getMaxValueFast(keyTimes.current, 1);
			if (maxTime > MaxKeystrokeThresholdMs) {
				if(IsDebug) console.log(`dropped buffer due to maxtime '${maxTime}'`, keyTimes.current);
				keyTimes.current = [];
				return; // drop and ignore input
			}
			if(IsDebug) console.log('accepted buffer', buffer.length);
		}

    const result = processKeyBuffer(buffer);
		// reset key buffer
		keyBufferRef.current.length = 0;

		processStringInput(e, result);
		const maxTime = getMaxValueFast(keyTimes.current, 1);
		if(IsDebug) console.log(`keytimes maxtime '${maxTime}'`, keyTimes.current);
		keyTimes.current = [];
  };

	const processStringInput = (e, result) => {
		const barcodeText = result.barcodeText;
		const text = result.text;
		// process raw value into an input object with decoded information
		if (barcodeText && barcodeText.length > 0) {
			const input = processBarcodeInformation(barcodeText);

			if (enableSound) {
				playScanSoundRef.current();
			}
			// fire an mounted event handler that we received data
			onReceived(e, input);
			// fire a domain event
			AppEvents.sendEvent(Events.BarcodeReceived, { barcode: input, text: text }, id || "BarcodeScannerInput", document.activeElement);
		}else{
			console.warn('no scan found, filtered.');
		}
		setIsReceiving(false);
	};

	/**
	 * Process an array of key input objects into a string buffer
	 * @param {array} buffer The array of Key input objects
	 * @param {array} length If provided, will only process the length specified (useful for peeking at data)
	 * @returns 
	 */
  const processKeyBuffer = (buffer, length = 99999) => {
    let str = "";
		let noControlCodesStr = "";
    let specialCharBuffer = [];
		let modifierKeyCount = 0;
    for (let i = 0; i < Math.min(buffer.length, length); i++) {
      let key = buffer[i];
			if (key.altKey || key.shiftKey || key.ctrlKey)
				modifierKeyCount++;

      // check for alt key
      if (key.keyCode === 18) {
        // it's a special character, read until alt is no longer pressed
        specialCharBuffer = [];
				continue;
      } else if (key.altKey) {
        // add special character
        specialCharBuffer.push(key.key);
				continue;
      } else if (specialCharBuffer.length > 0) {
        // process special character string into the actual ASCII character
        const charStr = specialCharBuffer.join("");
        const charCode = parseInt(charStr);
        const char = String.fromCharCode(charCode);
        str += char;
        specialCharBuffer = [];
      }  
			
			// normal character
			let char = key.isFake ? key.key : String.fromCharCode(96 <= key.keyCode && key.keyCode <= 105 ? key.keyCode - 48 : key.keyCode);
			
			if (key.shiftKey) char = key.key;
			if ((key.keyCode >= 186 && key.keyCode <= 192) || (key.keyCode >= 219 && key.keyCode <= 222)) char = key.key;
			if (
				key.isFake ||
				key.keyCode === 13 ||
				key.keyCode === 32 ||
				key.keyCode === 9 ||
				(key.keyCode >= 48 && key.keyCode <= 90) ||
				(key.keyCode >= 107 && key.keyCode <= 111) ||
				(key.keyCode >= 186 && key.keyCode <= 222)
			) {
				str += char;
				if (!key.altKey && !key.ctrlKey && key.keyCode !== 13 && key.keyCode !== 10 && key.keyCode !== 9)
					noControlCodesStr += char;
			}
    }

		if (buffer.length === modifierKeyCount) {
			return null;
		}
    return { barcodeText: str, text: noControlCodesStr };
  };

  const processBarcodeInformation = (value) => {
    let barcodeType = "code128";
    let parsedValue = {};
		let correctedValue = value;
		let gsDetected = false;
		let rsDetected = false;
		let eotDetected = false;
		let invalidBarcodeDetected = false;
    if (value.startsWith(barcodeConfig.barcodePrefix2D)) {
      // 2D DotMatrix barcode. Process into value.
      barcodeType = "datamatrix";
      const parseResult = parseDataMatrix(value);
			parsedValue = parseResult.value;
			gsDetected = parseResult.gsDetected;
			rsDetected = parseResult.rsDetected;
			eotDetected = parseResult.eotDetected;
			invalidBarcodeDetected = parseResult.invalidBarcodeDetected;
			correctedValue = parseResult.correctedValue;
    } else {
      // 1D barcode
      parsedValue = value.replace("\n", "").replace("\r", "");
    }

		return {
			type: barcodeType,
			value: parsedValue,
			correctedValue: correctedValue,
			rawValue: value,
			rsDetected,
			gsDetected,
			eotDetected,
			invalidBarcodeDetected
		};
  };

  const parseDataMatrix = (value) => {
    let parsedValue = {};
		// https://honeywellaidc.force.com/supportppr/s/article/What-do-Control-Characters-SOH-STX-etc-mean-when-scanning
		const gsCharCodes = ["\u001d", "\u005d", "\u241d"]; // CTRL-], \u001d, GROUP SEPARATOR
		const rsCharCodes = ["\u001e", "\u005e", "\u241e"]; // CTRL-^, \u001e, RECORD SEPARATOR
    const eotCharCodes = ["\u0004", "^\u0044", "\u2404"]; // CTRL-D, \u0004, END OF TRANSMISSION
		const crCharCodes = ["\r", "\u240d"]; // 13, line feed
		const lfCharCodes = ["\n", "\u240a"]; // 10, carriage return
		const fileSeparatorCharCodes = ["\u001c", "\u241c"]; // ctl-\, \u001c FILE SEPARATOR 
		const sohCharCodes = ["\u0001"]; // CTRL-A, \u0001 START OF HEADER
		const stxCharCodes = ["\u0002"]; // CTRL-B, \u0002 START OF TEXT
		const etxCharCodes = ["\u0003"]; // CTRL-C, \u0003 END OF TEXT
    const header = barcodeConfig.barcodePrefix2D;
    const expectedFormatNumber = 6; /** 22z22 barcode */
    const controlChars = ["P", "1P", "P1", "K", "1K", "10K", "11K", "4L", "Q", "11Z", "12Z", "13Z", "20Z"];

		let gsCodePresent = false;
		let rsCodePresent = false;
		let eotCodePresent = false;
    let formatNumber = "";
    let buffer = "";
    let i;
    let formatNumberIndex = 0;
		let correctedValue = value.toString();
		// normalize the control codes so we don't have multiple values to worry about
		correctedValue = normalizeControlCharacters(correctedValue);

		correctedValue = correctedValue.replaceAll("\u001d", "\u241d"); // GS
		correctedValue = correctedValue.replaceAll("\u005d", "\u241d"); // GS

		correctedValue = correctedValue.replaceAll("\u001e", "\u241e"); // RS
		correctedValue = correctedValue.replaceAll("\u005e", "\u241e"); // RS
		correctedValue = correctedValue.replaceAll("\u0004", "\u2404"); // EOT
		correctedValue = correctedValue.replaceAll("^\u0044", "\u2404"); // EOT

		gsCodePresent = gsCharCodes.some(v => correctedValue.includes(v));
		rsCodePresent = rsCharCodes.some(v => correctedValue.includes(v));
		eotCodePresent = eotCharCodes.some(v => correctedValue.includes(v));

		// read in the format number first. For Digikey 2d barcodes, this should be 6 (expectedFormatNumber)
    for (i = 0; i < correctedValue.length; i++) {
      buffer += correctedValue[i];
      if (buffer === header) {
        if (rsCharCodes.includes(correctedValue[i + 1])) {
          // read the character after the RS token (sometimes not present)
          formatNumberIndex = i + 2;
        } else {
          formatNumberIndex = i + 1;
        }
        formatNumber = parseInt(correctedValue[formatNumberIndex] + correctedValue[formatNumberIndex + 1]);
				i += formatNumberIndex + 1;
        break;
      }
    }
		// assert expected barcode format number
    if (formatNumber !== expectedFormatNumber) {
      // error
			console.error(`Expected the 2D barcode format number of ${expectedFormatNumber} but was ${formatNumber}`);
      return {};
    }

    let lastPosition = i;
		let gsLines = [];
		let gsLine = '';
		// break each group separator into an array
		for (i = lastPosition; i < correctedValue.length; i++) {
			const ch = correctedValue[i];
			if (gsCharCodes.includes(ch)) {
				// start of a new line. read until next gsCharCode or EOT
				if (gsLine.length > 0)
					gsLines.push(gsLine);
				gsLine = '';
			} else {
				gsLine += ch;
			}
		}
		if (gsLine.length > 0)
			gsLines.push(gsLine);

		let invalidBarcodeDetected = false;
		// some older DigiKey barcodes are encoded incorrectly, and have a blank GSRS at the end. Filter them out.
		// https://github.com/replaysMike/Binner/issues/132
		if (isInvalidBarcode(gsLines)) {
			gsLines = fixInvalidBarcode(gsLines);
			invalidBarcodeDetected = true;
		}
		let readLength = gsLines.length;
		// read each group separator
		for (i = 0; i < readLength; i++) {
			// read until we see a control char
			const line = gsLines[i];
			let readCommandType = "";
			let readValue = "";
			let readControlChars = true;
			for (var c = 0; c < line.length; c++) {
				if (readControlChars) readCommandType += line[c];
				else readValue += line[c];

				if (readControlChars === header || readControlChars === formatNumber) readValue = "";
				if (controlChars.includes(readCommandType)) {
					// start reading value
					readControlChars = false;
				}
			}
			switch (readCommandType) {
				case "P":
					// could be DigiKey part number, or customer reference value
					parsedValue["description"] = readValue;
					break;
				case "1P":
					// manufacturer part number
					parsedValue["mfgPartNumber"] = readValue;
					break;
				case "1K":
					// Salesorder#
					parsedValue["salesOrder"] = readValue;
					break;
				case "10K":
					// invoice#
					parsedValue["invoice"] = readValue;
					break;
				case "11K":
					// don't know
					parsedValue["unknown1"] = readValue;
					break;
				case "4L":
					// country of origin
					parsedValue["countryOfOrigin"] = readValue;
					break;
				case "Q":
					// quantity
					const parsedIntValue = parseInt(readValue);
					if (isNaN(parsedIntValue))
						parsedValue["quantity"] = readValue;
					else
						parsedValue["quantity"] = parsedIntValue;
					break;
				case "11Z":
					// the value PICK
					parsedValue["pick"] = readValue;
					break;
				case "12Z":
					// internal part id
					parsedValue["partId"] = readValue;
					break;
				case "13Z":
					// shipment load id
					parsedValue["loadId"] = readValue;
					break;
				default:
					break;
			}
		}

		correctedValue = buildBarcode(expectedFormatNumber, gsLines);
    return {
			rawValue: value,
			value: parsedValue,
			correctedValue: correctedValue,
			gsDetected: gsCodePresent,
			rsDetected: rsCodePresent,
			eotDetected: eotCodePresent,
			gsLines: gsLines,
			invalidBarcodeDetected
		};
  };

	const buildBarcode = (formatNumber, gsLines) => {
		let barcode = `${barcodeConfig.barcodePrefix2D}\u241e${formatNumber.toString().padStart(2, '0')}`; // Header + RS + formatNumber
		for(let i = 0; i < gsLines.length; i++){
			barcode = barcode + "\u241d" + gsLines[i]; // GS
		}
		barcode = barcode + "\u2404\r"; // EOT + CR
		return barcode;
	};

	const normalizeControlCharacters = (str) => {
		// convert all variations of the control code to their equiv unicode value
		let normalizedStr = copyString(str);
		normalizedStr = normalizedStr.replaceAll("\u001d", "\u241d"); // GS
		normalizedStr = normalizedStr.replaceAll("\u005d", "\u241d"); // GS

		normalizedStr = normalizedStr.replaceAll("\u001e", "\u241e"); // RS
		normalizedStr = normalizedStr.replaceAll("\u005e", "\u241e"); // RS
		normalizedStr = normalizedStr.replaceAll("\u0004", "\u2404"); // EOT
		normalizedStr = normalizedStr.replaceAll("^\u0044", "\u2404"); // EOT
		return normalizedStr;
	};

	const isInvalidBarcode = (gsLines) => {
		for(let i = 0; i < gsLines.length; i++){ 
			if (gsLines[i].includes("\u241e")) { // RS
				return true;
			}
		}
		return false;
	};

	const fixInvalidBarcode = (gsLines) => {
		const newGsLines = [];
		for(let i = 0; i < gsLines.length; i++){ 
			if (gsLines[i].includes("\u241e")) { // RS
				// is there data before the RS character?
				const rsIndex = gsLines[i].indexOf("\u241e");
				if (rsIndex > 0) {
					const data = gsLines[i].substring(0, rsIndex);
					newGsLines.push(data);
				}
				continue;
			}
			newGsLines.push(gsLines[i]);
		}
		return newGsLines;
	};

	// create a debouncer, but with the ability to update it's interval as needed
	const scannerDebounced = useMemo(() => dynamicDebouncer(onReceivedBarcodeInput, () => BarcodeScannerInput.debounceIntervalMs), []);

	const disableBarcodeInput = (e) => {
		if(IsDebug) console.log('disabled barcode input on request');
		setPreviousIsKeyboardListeningState(isKeyboardListening);
		setIsKeyboardListening(false);
		removeKeyboardHandler();
	};

	const restoreBarcodeInput = (e) => {
		if(IsDebug) console.log('enabled barcode input on request');
		setIsKeyboardListening(previousIsKeyboardListeningState);
		addKeyboardHandler();
	};

  useEffect(() => {
		const enableListening = () => {
			// start listening for all key presses on page
			addKeyboardHandler();
			// add event listeners to receive requests to disable/enable barcode capture
			document.body.addEventListener(Events.DisableBarcodeInput, disableBarcodeInput);
			document.body.addEventListener(Events.RestoreBarcodeInput, restoreBarcodeInput);
			document.body.addEventListener(Events.BarcodeInput, (event) => processStringInput(event, { barcodeText: event.detail, text: event.detail }));
		};

		if (!config) {
			fetchApi("/api/system/settings").then((response) => {
				const { data } = response;
				const barcodeConfig = data.barcode;
				setBarcodeConfig(barcodeConfig);
				if (onSetConfig)
					onSetConfig(barcodeConfig);

				// update the static debounce interval
				BarcodeScannerInput.debounceIntervalMs = parseTimeSpan(barcodeConfig.bufferTime).toMilliseconds();
				if (barcodeConfig.enabled) enableListening();
				else if (onDisabled) onDisabled();
			});
		} else {
			setBarcodeConfig(config);
			if (config.enabled) enableListening();
			else if (onDisabled) onDisabled();
		}
		return () => {
			// stop listening for key presses
			removeKeyboardHandler();
			// remove event listeners
			document.body.removeEventListener(Events.DisableBarcodeInput, disableBarcodeInput);
			document.body.removeEventListener(Events.RestoreBarcodeInput, restoreBarcodeInput);
		};
  }, []);

	useEffect(() => {
		if (config) {
			setBarcodeConfig({...config});
			// update the static debounce interval
			BarcodeScannerInput.debounceIntervalMs = parseTimeSpan(config.bufferTime).toMilliseconds();
		}
	}, [config])

  useEffect(() => {
		// handle changes to the incoming listening prop
    setIsKeyboardListening(listening);
		listeningRef.current = listening;
  }, [listening]);

	useEffect(() => {
		// handle changes to keyboard input passed directly to the component.
		// this is used to inject data to the keypress buffer
		if (passThrough && passThrough.length > 0){
			for(let i = 0; i < passThrough.length; i++) {
				const fakeKeyPress = { key: passThrough[i], keyCode: passThrough[i].charCodeAt(0), altKey: false, ctrlKey: false, shiftKey: false, isFake: true };
				keyBufferRef.current.push(fakeKeyPress);
			}
		}
  }, [passThrough]);

  const addKeyboardHandler = () => {
    if (document) {
      document.addEventListener("keydown", onKeydown);
    }
  };

  const removeKeyboardHandler = () => {
    if (document) {
      document.removeEventListener("keydown", onKeydown);
    }
  };

  // listens for document keydown events, used for barcode scanner input
  const onKeydown = (e) => {
    if (listeningRef.current === true) {
			if (swallowKeyEvent 
					// dont swallow function keys
					&& !(e.keyCode >= 112 && e.keyCode <= 123)
					// dont swallow copy/paste
					&& !(e.ctrlKey && (e.key === "c" || e.key === "v" || e.key === "x"))
					&& !(e.shiftKey && (e.key === "Insert"))
					) {
				e.preventDefault();
				e.stopPropagation();
			}
			// special case, swallow CTRL-SHIFT-D which changes the inspector dock window position
			if (e.code === "KeyD" && e.shiftKey && e.ctrlKey) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			keyBufferRef.current.push(e);

			const maxTime = getMaxValueFast(keyTimes.current, 1);
			if (keyBufferRef.current.length > MinKeystrokesToConsiderScanningEvent && maxTime < MaxKeystrokeThresholdMs) {
				setIsReceiving(true);
				// only send the event once when we've determined we are capturing
				if(!isStartedReading.current) AppEvents.sendEvent(Events.BarcodeReading, keyBufferRef.current, id || "BarcodeScannerInput", document.activeElement);
				isStartedReading.current = true;	
			}

			// visual indicator of input received
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				// barcode scan stopped
				setIsReceiving(false);
				if(isStartedReading.current) AppEvents.sendEvent(Events.BarcodeReadingCancelled, keyBufferRef.current, id || "BarcodeScannerInput", document.activeElement);
				isStartedReading.current = false;
			}, AbortBufferTimerMs);

			keyTimes.current.push(new Date().getTime() - lastKeyTime.current);
			lastKeyTime.current = new Date().getTime();
      scannerDebounced(e, keyBufferRef.current);
    } else {
			// dropped key, not listening
			if(IsDebug) console.log('input ignored, not listening');
		}
		return e;
  };

	// helpers

	const getMaxValueFast = (arr, startAt = 0) => {
		// fastest performing solution of getting the max value in an array
		if (startAt >= arr.length) return arr.length > 0 ? arr[0] : -1;
		let max = arr[startAt];
		for (let i = startAt + 1; i < arr.length; ++i) {
			if (arr[i] > max) {
				max = arr[i];
			}
		}
		return max;
	}

	if (!barcodeConfig.enabled)
		return (<></>);

  return (
    <div style={{ float: "right" }}>
      <Popup
        position="bottom right"
        hoverable
        content={
          <p>
						<Trans i18nKey="comp.barcodeScannerInput.supportsBarcodeScanning">
						This page supports barcode scanning. <Link to={helpUrl}>More Info</Link>
						</Trans>
          </p>
        }
        trigger={<Image src="/image/barcode.png" width={35} height={35} className={`barcode-support ${isReceiving ? "receiving" : ""}`} />}
      />
    </div>
  );
}

BarcodeScannerInput.propTypes = {
  /** Event handler when scanning input has been received */
  onReceived: PropTypes.func.isRequired,
  /** Set this to true to listen for barcode input */
  listening: PropTypes.bool,
  /** keyboard buffer smaller than this length will ignore input */
  minInputLength: PropTypes.number,
	/** help url when clicking on the scanner icon */
  helpUrl: PropTypes.string,
	/** true to swallow key events */
	swallowKeyEvent: PropTypes.bool,
	/** keyboard passthrough, for passing data directly to component */
	passThrough: PropTypes.string,
	/** True to enable beep sound when an item is scanned */
	enableSound: PropTypes.bool,
	/** Set the barcode config */
	config: PropTypes.object,
	/** Fired when the configuration is updated */
	onSetConfig: PropTypes.func,
	/** Fired when barcode support is disabled */
	onDisabled: PropTypes.func
};

BarcodeScannerInput.defaultProps = {
  listening: true,
  minInputLength: 4,
  helpUrl: "/help/scanning",
	swallowKeyEvent: true,
	enableSound: true
};

// store the debounce interval statically, so it can be modified and used by a memoized debounce function
BarcodeScannerInput.debounceIntervalMs = DefaultDebounceIntervalMs;
