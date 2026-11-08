// Read-only checks before the uninstaller removes shared Windows entries.
#pragma once
#include <shobjidl.h>
#include "uninstall-data.h"

namespace uninstall_ownership {
inline DWORD Registration(LPCWSTR key, LPCWSTR root, DWORD view) {
    HKEY opened = nullptr;
    const LSTATUS status = RegOpenKeyExW(HKEY_CURRENT_USER, key, 0, KEY_QUERY_VALUE | view, &opened);
    if (status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND) return ERROR_SUCCESS;
    if (status != ERROR_SUCCESS) return status;
    WCHAR value[32768];
    DWORD bytes = sizeof(value);
    const LSTATUS read = RegGetValueW(opened, nullptr, L"InstallLocation", RRF_RT_REG_SZ, nullptr, value, &bytes);
    RegCloseKey(opened);
    if (read != ERROR_SUCCESS) return read;
    std::wstring expected, actual;
    if (!uninstall_data::Normalize(root, expected) || !uninstall_data::Normalize(value, actual)) return ERROR_INVALID_NAME;
    return _wcsicmp(expected.c_str(), actual.c_str()) == 0 ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
}

inline DWORD Shortcut(LPCWSTR path, LPCWSTR executable, LPCWSTR legacyExecutable) {
    if (!path || !*path) return ERROR_SUCCESS;
    if (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) {
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ERROR_SUCCESS : error;
    }
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return ERROR_ACCESS_DENIED;
    IShellLinkW* link = nullptr;
    IPersistFile* file = nullptr;
    HRESULT result = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link));
    if (SUCCEEDED(result)) result = link->QueryInterface(IID_PPV_ARGS(&file));
    if (SUCCEEDED(result)) result = file->Load(path, STGM_READ);
    WCHAR target[32768]{};
    WCHAR workingDirectory[32768]{};
    WCHAR arguments[32768]{};
    if (SUCCEEDED(result)) result = link->GetPath(target, ARRAYSIZE(target), nullptr, SLGP_RAWPATH);
    if (SUCCEEDED(result)) result = link->GetWorkingDirectory(workingDirectory, ARRAYSIZE(workingDirectory));
    if (SUCCEEDED(result)) result = link->GetArguments(arguments, ARRAYSIZE(arguments));
    if (file) file->Release();
    if (link) link->Release();
    if (SUCCEEDED(initialized)) CoUninitialize();
    if (FAILED(result)) return ERROR_ACCESS_DENIED;
    std::wstring expected, legacy, actual, directory;
    if (!uninstall_data::Normalize(executable, expected) || !uninstall_data::Normalize(legacyExecutable, legacy)
        || !uninstall_data::Normalize(target, actual) || !uninstall_data::Normalize(workingDirectory, directory)) return ERROR_INVALID_NAME;
    const std::wstring appDirectory = expected.substr(0, expected.rfind(L'\\'));
    const std::wstring rootDirectory = legacy.substr(0, legacy.rfind(L'\\'));
    if (*arguments || (_wcsicmp(directory.c_str(), appDirectory.c_str()) != 0
        && _wcsicmp(directory.c_str(), rootDirectory.c_str()) != 0)) return ERROR_ACCESS_DENIED;
    return _wcsicmp(expected.c_str(), actual.c_str()) == 0 || _wcsicmp(legacy.c_str(), actual.c_str()) == 0
        ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
}
}
