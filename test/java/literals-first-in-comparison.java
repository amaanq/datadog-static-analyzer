class Foo {
    boolean bar(String x) {
        return x.equals("42"); // should be "42".equals(x)
    }
    boolean bar(String x) {
        return x.equalsIgnoreCase("42"); // should be "42".equalsIgnoreCase(x)
    }
    boolean bar(String x) {
        return (x.compareTo("bar") > 0); // should be: "bar".compareTo(x) < 0
    }
    boolean bar(String x) {
        return (x.compareToIgnoreCase("bar") > 0); // should be: "bar".compareToIgnoreCase(x) < 0
    }
    boolean baz(String x) {
        return x.contentEquals("baz"); // should be "baz".contentEquals(x)
    }
}