# dsh-locator

[![npm](https://img.shields.io/npm/v/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![ci](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml)

[English](README.md) | [中文](README-zh.md) | [Español](README-es.md) | [Português](README-pt.md) | हिन्दी

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) के लिए अपना खुद का इंडेक्स बनाने वाला पूरे डिस्क का फ़ाइल खोज प्लगइन। Everything, `es.exe` या किसी सेवा की ज़रूरत नहीं।

## इंस्टॉल

```sh
dsh plugin --profile web add dsh-locator
```

चल रही Web GUI में इंस्टॉल करने के बाद पेज रीलोड करें। पैनल `Ctrl+Shift+F` से या साइडबार के निचले हिस्से में दिए आवर्धक चिह्न से खुलता है।

## क्या करता है

- नाम, पथ, आकार और तारीख़ का स्थायी इंडेक्स; दस लाख से अधिक प्रविष्टियों पर भी कुछ दसियों मिलीसेकंड में परिणाम।
- समानांतर स्कैन और खोज; पहली खोज प्रारंभिक स्कैन के दौरान भी उत्तर देती है (`indexing: true`)।
- नेटिव अपडेट: Linux में inotify, Windows में `ReadDirectoryChangesW`, macOS में kqueue (समय-समय पर पुनर्निर्माण के साथ)।
- Windows पर व्यवस्थापक के रूप में चलने पर वैकल्पिक USN/MFT तेज़ रास्ता (`windowsUsn: true`); विफल होने पर सामान्य डायरेक्टरी स्कैन।
- Web पैनल: कॉलम से क्रमबद्ध करें, फ़िल्टर करें, कीबोर्ड से चलें, पथ कॉपी करें और **डबल-क्लिक से फ़ाइल मैनेजर में दिखाएँ**।

## टूल्स

| टूल | काम |
|---|---|
| `locator_search` | Everything जैसी क्वेरी: `ext:pdf`, `size:>10mb`, `dm:thisweek`, `path:src`, वाइल्डकार्ड और `!` से नकार। |
| `locator_status` | रूट, प्रविष्टियाँ, watcher की स्थिति, USN मोड और त्रुटियाँ। |
| `locator_rebuild` | पृष्ठभूमि में इंडेक्स दोबारा बनाएँ। |
| `locator_export` | केवल-पढ़ने योग्य SQLite प्रति लिखें (`entries(path, name, dir, size, mtime_ms, ext)`)। |

## मुख्य कॉन्फ़िग

| कुंजी | अर्थ |
|---|---|
| `roots` | इंडेक्स करने वाली डायरेक्टरियाँ; खाली = होम डायरेक्टरी। |
| `excludes` | छोड़ने के लिए नाम-आधारित glob (`node_modules`, `.git`, …)। |
| `watch` | सिस्टम की फ़ाइल सूचनाएँ चालू करें। |
| `refreshIntervalMs` | नेटिव watcher न होने पर समय-समय पर पुनर्निर्माण। |
| `windowsUsn` | USN/MFT तेज़ रास्ता (केवल Windows, व्यवस्थापक; डिफ़ॉल्ट `false`)। |
| `stateDir` | स्नैपशॉट डायरेक्टरी; खाली = सिस्टम कैश। |

## सीमाएँ

- केवल नाम, पथ, आकार और तारीख़ — **सामग्री इंडेक्स नहीं**। सामग्री के लिए `grep`।
- Windows: USN/MFT वैकल्पिक, व्यवस्थापक और सक्रिय चेंज जर्नल चाहिए; वरना सामान्य स्कैन।
- macOS: kqueue बनना/हटना/नाम बदलना देखता है; सामग्री बदलाव समय-समय पर पुनर्निर्माण से।
- स्नैपशॉट स्थानीय; कोई नेटवर्क या टेलीमेट्री नहीं।

पूर्ण दस्तावेज़: [English](README.md), [中文](README-zh.md)। लाइसेंस Apache-2.0।
