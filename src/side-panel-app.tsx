// ... in the Translate mode section ...
{ _TRANSLATE_TARGET_LANGUAGES.map((lang) => (
  <option key={lang} value={lang}>
    {lang.charAt(0).toUpperCase() + lang.slice(1)}
  </option>
)) }
// ... rest of file ...
